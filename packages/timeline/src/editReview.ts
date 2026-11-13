/**
 * One edit looked at on its own: where it changed the timeline, what it took out, where that
 * place is now, and taking just that edit back out from under the edits made after it. Pure;
 * frames are whole timeline frames.
 */
import { diffTimelines, mergeTimelines, type TimelineChange } from "./diff.ts";
import { layoutTimeline } from "./layout.ts";
import type { Clip, Timeline } from "./otio.ts";
import { offsetAtSourceSeconds, sourceSecondsAt } from "./speed.ts";

export interface FrameSpan {
  readonly start: number;
  readonly end: number;
}

/** The footage playing at a frame: what stays findable however the clips around it move. */
export interface FrameAnchor {
  readonly track: string;
  readonly target: string;
  /** Seconds into the media file. */
  readonly seconds: number;
}

export interface ChangePlace {
  /** Where the change is in the later version: the join of a cut; null when it has no place. */
  readonly frame: number | null;
  /** The first stretch taken out, in the earlier version's frames. */
  readonly removed: FrameSpan | null;
  /** The footage at `frame` in the later version; null when no media plays there. */
  readonly anchor: FrameAnchor | null;
}

const frameOf = (change: TimelineChange): number | null => {
  switch (change.kind) {
    case "added":
    case "moved":
    case "changed":
      return change.after.startFrame;
    case "removed":
      return change.before.startFrame;
    case "trimmed":
      return change.start === undefined ? change.after.endFrame : change.after.startFrame;
    case "rippled":
      return change.fromFrame + Math.min(0, change.byFrames);
    case "markerAdded":
    case "markerChanged":
      return change.after.frame;
    case "markerRemoved":
      return change.before.frame;
    case "trackAdded":
    case "trackRemoved":
    case "trackRenamed":
    case "trackChanged":
      return null;
  }
};

/** Where a change starts taking footage out, in the earlier version's frames, and where it stops. */
const shortened = (change: TimelineChange): FrameSpan | null => {
  if (change.kind === "removed") {
    return { start: change.before.startFrame, end: change.before.endFrame };
  }
  if (change.kind !== "trimmed") return null;
  if (change.end !== undefined && change.end.after < change.end.before) {
    return { start: change.end.after, end: change.end.before };
  }
  if (change.start !== undefined && change.start.after > change.start.before) {
    return { start: change.start.before, end: change.start.after };
  }
  return null;
};

const targetOf = (clip: Clip) => clip.media_references.DEFAULT_MEDIA.target_url;

/** The footage on each track at a frame, top track first. */
const anchorsAt = (timeline: Timeline, frame: number): ReadonlyArray<FrameAnchor> => {
  const layout = layoutTimeline(timeline);
  return layout.tracks.flatMap((track) =>
    track.clips.flatMap((item) => {
      const target = targetOf(item.clip);
      if (target === "" || frame < item.startFrame || frame >= item.endFrame) return [];
      return [
        {
          track: track.name,
          target,
          seconds: sourceSecondsAt(item.clip, (frame - item.startFrame) / layout.rate),
        },
      ];
    }),
  );
};

// Source times are seconds; a frame's worth of rounding either way is still the same moment.
const ANCHOR_SLACK_SECONDS = 0.0005;

/**
 * Where an anchor's footage plays in `timeline`; null when it no longer does. The same footage
 * placed twice resolves to its own track first, then to the place nearest `near`.
 */
export const frameOfAnchor = (
  timeline: Timeline,
  anchor: FrameAnchor,
  near: number,
): number | null => {
  const layout = layoutTimeline(timeline);
  const found = layout.tracks.flatMap((track) =>
    track.clips.flatMap((item) => {
      if (targetOf(item.clip) !== anchor.target) return [];
      const offset = offsetAtSourceSeconds(item.clip, anchor.seconds);
      const length = (item.endFrame - item.startFrame) / layout.rate;
      if (offset < -ANCHOR_SLACK_SECONDS || offset >= length - ANCHOR_SLACK_SECONDS) return [];
      return [
        {
          frame: Math.round(item.startFrame + Math.max(0, offset) * layout.rate),
          sameTrack: track.name === anchor.track,
        },
      ];
    }),
  );
  const [best] = found.toSorted(
    (a, b) =>
      Number(b.sameTrack) - Number(a.sameTrack) ||
      Math.abs(a.frame - near) - Math.abs(b.frame - near),
  );
  return best?.frame ?? null;
};

const subjectOf = (change: TimelineChange): string => {
  switch (change.kind) {
    case "added":
    case "moved":
    case "changed":
      return change.after.name;
    case "removed":
    case "trimmed":
      return change.before.name;
    case "rippled":
      return "the clips after it";
    case "markerAdded":
    case "markerChanged":
      return `marker ${change.after.name}`.trim();
    case "markerRemoved":
      return `marker ${change.before.name}`.trim();
    case "trackAdded":
    case "trackRemoved":
    case "trackChanged":
      return `track ${change.track}`;
    case "trackRenamed":
      return `track ${change.before}`;
  }
};

export interface CarriedChange {
  readonly timeline: Timeline;
  /** What was changed since that the change touches too; when any, `timeline` is not to be used. */
  readonly overlaps: ReadonlyArray<string>;
}

/**
 * `current` with the change from `from` to `to` made under it: `to`, with everything done
 * between `from` and `current` done again on top. Undoing an edit carries its after-to-before
 * change; putting it back carries before-to-after. Every later change fits or the whole is
 * refused: one dropped would leave the timeline in a state nobody made.
 */
export const carryChange = (from: Timeline, to: Timeline, current: Timeline): CarriedChange => {
  try {
    // The later changes are the side re-applied: the merge places cuts and trims, and an edit
    // taken out is mostly footage put back, which it can't place over what came after.
    const merged = mergeTimelines(from, current, to);
    return {
      timeline: merged.timeline,
      overlaps: [...new Set(merged.conflicts.map((conflict) => subjectOf(conflict.change)))],
    };
  } catch {
    // The diff throws on a text that is JSON but not a timeline it can lay out.
    return { timeline: current, overlaps: ["the timeline, which can't be read as one"] };
  }
};

/**
 * The first stretch taken out, in `before`'s frames. It starts where the first clip was cut
 * into. Where the cut closed up, it ends at the footage that now plays from the join; where it
 * left a gap, it is the clip or edge that was taken.
 */
const removedBy = (
  changes: ReadonlyArray<TimelineChange>,
  before: Timeline,
  after: Timeline,
): FrameSpan | null => {
  const [first] = changes
    .map(shortened)
    .filter((span) => span !== null)
    .toSorted((a, b) => a.start - b.start);
  if (first === undefined) return null;
  for (const anchor of anchorsAt(after, first.start)) {
    const end = frameOfAnchor(before, anchor, first.start);
    if (end !== null && end > first.start) return { start: first.start, end };
  }
  return first;
};

export const NOWHERE: ChangePlace = { frame: null, removed: null, anchor: null };

/** Where `changes`, which led from `before` to `after`, changed the timeline. */
export const placeOfChanges = (
  changes: ReadonlyArray<TimelineChange>,
  before: Timeline,
  after: Timeline,
): ChangePlace => {
  const removed = removedBy(changes, before, after);
  const frames = changes.map(frameOf).filter((frame) => frame !== null);
  const frame = removed?.start ?? (frames.length === 0 ? null : Math.min(...frames));
  return { frame, removed, anchor: frame === null ? null : (anchorsAt(after, frame)[0] ?? null) };
};

/** Where the change from `before` to `after` is; nowhere when either can't be laid out. */
export const placeBetween = (before: Timeline, after: Timeline): ChangePlace => {
  try {
    return placeOfChanges(diffTimelines(before, after).changes, before, after);
  } catch {
    return NOWHERE;
  }
};
