/**
 * The steps that turn the sequence Premiere holds into the timeline edited here, in Premiere's
 * terms, for an agent to apply to the live sequence so effects and hand polish stay untouched.
 * Each step is tried on a copy of Premiere's version with the edits of `edits.ts` and kept only
 * when it brings the copy closer to ours; what no step reaches is listed as `manual`. Pure.
 */
import { changeSentence, diffTimelines, type TimelineChange } from "../diff.ts";
import { applyEdits, STILL_PATH, type TimelineEdit } from "../edits.ts";
import { clipIdOf, layoutTimeline } from "../layout.ts";
import { type Clip, type Timeline, TIMELINE_NAMESPACE, type Track } from "../otio.ts";

export interface PushTrack {
  readonly kind: "video" | "audio";
  /** 1-based among tracks of its kind, as Premiere numbers them: V1 is video 1. */
  readonly index: number;
  readonly name: string;
}

export interface PushTime {
  readonly frame: number;
  readonly seconds: number;
}

/** A clip as it sits in the sequence at the moment its step runs. */
export interface PushClip {
  readonly name: string;
  readonly track: PushTrack;
  readonly start: PushTime;
  readonly end: PushTime;
}

export type PushStep =
  /** Cut [start, end) out of `tracks` and close it up; `heldTracks` must not shift. */
  | {
      readonly kind: "rippleRemove";
      readonly start: PushTime;
      readonly end: PushTime;
      readonly tracks: ReadonlyArray<PushTrack>;
      readonly heldTracks: ReadonlyArray<PushTrack>;
    }
  /** Remove the clip and leave its gap open. */
  | { readonly kind: "remove"; readonly clip: PushClip }
  /** `sourceSeconds` is the new source in (start) or out (end); null for a still or graphic. */
  | {
      readonly kind: "trim";
      readonly clip: PushClip;
      readonly edge: "start" | "end";
      readonly to: PushTime;
      readonly sourceSeconds: number | null;
    }
  | {
      readonly kind: "move";
      readonly clip: PushClip;
      readonly toTrack: PushTrack;
      readonly toStart: PushTime;
    }
  | { readonly kind: "setEnabled"; readonly clip: PushClip; readonly enabled: boolean }
  | { readonly kind: "split"; readonly clip: PushClip; readonly at: PushTime };

export interface PushPlan {
  /** Frames per second of the sequence. */
  readonly rate: number;
  /**
   * In the order to run them: ripple removes from the end of the timeline toward the start,
   * then splits, removes, trims, moves and enables, each also from the end. Every position is
   * the one the sequence has when that step runs, after the steps before it.
   */
  readonly steps: ReadonlyArray<PushStep>;
  /** What still differs after the steps, in plain words: no step here does it safely. */
  readonly manual: ReadonlyArray<string>;
  /** One numbered line per step, then the manual list. Empty when nothing differs. */
  readonly text: string;
}

/**
 * Seconds at a frame, to the microsecond. Rates like 59.94 are 60000/1001 exactly, which the
 * rate read from a project only approximates.
 */
export const secondsAtFrame = (frame: number, rate: number): number => {
  const nominal = Math.round(rate);
  const ntsc = nominal !== rate && Math.abs(rate - nominal / 1.001) < 0.01;
  const seconds = ntsc ? (frame * 1001) / (nominal * 1000) : frame / rate;
  return Math.round(seconds * 1e6) / 1e6;
};

interface Placed {
  readonly id: string;
  readonly track: string;
  readonly kind: Track["kind"];
  readonly start: number;
  readonly end: number;
  readonly clip: Clip;
}

const place = (timeline: Timeline): Array<Placed> => {
  const layout = layoutTimeline(timeline);
  return timeline.tracks.children.flatMap((track) =>
    (layout.tracks.find((laid) => laid.name === track.name)?.clips ?? []).map((item) => ({
      id: item.key,
      track: track.name,
      kind: track.kind,
      start: Math.round(item.startFrame),
      end: Math.round(item.endFrame),
      clip: item.clip,
    })),
  );
};

const mapTracks = (timeline: Timeline, change: (track: Track, index: number) => Track) => ({
  ...timeline,
  tracks: { ...timeline.tracks, children: timeline.tracks.children.map(change) },
});

/** The timeline with each clip's id replaced by what `idFor` returns for it, where it does. */
const withIds = (timeline: Timeline, idFor: (id: string) => string | undefined): Timeline =>
  mapTracks(timeline, (track, trackIndex) => ({
    ...track,
    children: track.children.map((child, childIndex) => {
      if (child.OTIO_SCHEMA !== "Clip.2") return child;
      const id = idFor(clipIdOf(child, `${trackIndex}:${childIndex}`));
      if (id === undefined) return child;
      const own = child.metadata[TIMELINE_NAMESPACE] as Record<string, unknown> | undefined;
      return { ...child, metadata: { ...child.metadata, [TIMELINE_NAMESPACE]: { ...own, id } } };
    }),
  }));

const targetOf = (clip: Clip) => clip.media_references.DEFAULT_MEDIA.target_url;
const isStill = (clip: Clip) => targetOf(clip) === "" || STILL_PATH.test(targetOf(clip));
const sourceSeconds = (clip: Clip) =>
  clip.source_range.start_time.value / clip.source_range.start_time.rate;
/** A clip's source in and out, in timeline frames. */
const sourceSpan = (clip: Clip, rate: number) => {
  const { duration } = clip.source_range;
  const start = Math.round(sourceSeconds(clip) * rate);
  return { start, end: start + Math.round((duration.value / duration.rate) * rate) };
};

/**
 * Gives each clip of the copy the id ours has for it, as the diff pairs clips by id first. A cut
 * names its later piece after the frame it was made at, which differs here because the steps
 * run in another order than the edits did; and once the copy is cut, the piece ours kept under
 * a clip's id may be another piece than the one holding that id here.
 */
const adoptIds = (working: Timeline, ours: ReadonlyArray<Placed>, rate: number): Timeline => {
  const mine = place(working);
  const oursById = new Map(ours.map((item) => [item.id, item]));
  const taken = new Set(mine.map((item) => item.id));
  const sameMedia = (a: Placed, b: Placed) =>
    a.kind === b.kind && targetOf(a.clip) === targetOf(b.clip);
  const overlap = (a: Placed, b: Placed) => {
    const x = sourceSpan(a.clip, rate);
    const y = sourceSpan(b.clip, rate);
    return Math.min(x.end, y.end) - Math.max(x.start, y.start);
  };
  const renames = new Map<string, string>();
  const paired = new Set<string>();
  const free: Array<Placed> = [];
  for (const item of mine) {
    const twin = oursById.get(item.id);
    if (twin !== undefined && sameMedia(item, twin) && !isStill(item.clip)) {
      if (overlap(item, twin) > 0) {
        paired.add(item.id);
        continue;
      }
      let fresh = `${item.id}/cut`;
      while (taken.has(fresh) || oursById.has(fresh)) fresh += "'";
      taken.add(fresh);
      renames.set(item.id, fresh);
    } else if (twin !== undefined) {
      paired.add(item.id);
      continue;
    }
    free.push(item);
  }
  const used = new Set<Placed>();
  for (const wanted of ours) {
    if (paired.has(wanted.id)) continue;
    const likeness = (item: Placed) =>
      isStill(wanted.clip)
        ? Number(item.clip.name === wanted.clip.name && item.track === wanted.track)
        : overlap(item, wanted);
    const distance = (item: Placed) =>
      Math.abs(item.start - wanted.start) + (item.track === wanted.track ? 0 : 1e9);
    const [best] = free
      .filter((item) => !used.has(item) && sameMedia(item, wanted) && likeness(item) > 0)
      .toSorted((a, b) => likeness(b) - likeness(a) || distance(a) - distance(b));
    if (best === undefined) continue;
    used.add(best);
    renames.set(best.id, wanted.id);
  }
  return renames.size === 0 ? working : withIds(working, (id) => renames.get(id));
};

interface Cut {
  readonly parent: Placed;
  readonly frame: number;
}

/** Where to cut the copy so that `wanted`, a piece of one of its clips, exists as its own clip. */
const cutFor = (mine: ReadonlyArray<Placed>, wanted: Placed, rate: number): Cut | undefined => {
  if (isStill(wanted.clip)) {
    // A still has no source time, so its piece is known only by lying inside it.
    const parent = mine.find(
      (item) =>
        item.track === wanted.track &&
        item.clip.name === wanted.clip.name &&
        targetOf(item.clip) === targetOf(wanted.clip) &&
        item.start < wanted.start &&
        wanted.end <= item.end,
    );
    return parent === undefined ? undefined : { parent, frame: wanted.start };
  }
  const at = sourceSpan(wanted.clip, rate).start;
  const parents = mine.filter((item) => {
    const span = sourceSpan(item.clip, rate);
    return (
      item.kind === wanted.kind &&
      targetOf(item.clip) === targetOf(wanted.clip) &&
      span.start < at &&
      at < span.end
    );
  });
  const parent = parents.find((item) => item.track === wanted.track) ?? parents[0];
  if (parent === undefined) return undefined;
  return { parent, frame: parent.start + at - sourceSpan(parent.clip, rate).start };
};

const cutAt = (timeline: Timeline, cut: Cut, id: string): Timeline =>
  withIds(
    applyEdits(timeline, [{ kind: "split", frame: cut.frame, tracks: [cut.parent.track] }]),
    (existing) => (existing === `${cut.parent.id}~${cut.frame}` ? id : undefined),
  );

/**
 * The copy with every piece ours cut off cut here too. Diffed against ours this shows a range
 * taken from the middle of a clip as a ripple from the cut, where the uncut copy would show it
 * from the clip's end.
 */
const precut = (working: Timeline, ours: ReadonlyArray<Placed>, rate: number): Timeline => {
  const known = new Set(place(working).map((item) => item.id));
  // Stills are left whole: their pieces are placed by position, which the ripples still change.
  const pieces = ours
    .filter((item) => !known.has(item.id) && !isStill(item.clip))
    .toSorted((a, b) => sourceSpan(a.clip, rate).start - sourceSpan(b.clip, rate).start);
  let cutUp = working;
  for (const wanted of pieces) {
    const cut = cutFor(place(cutUp), wanted, rate);
    if (cut !== undefined) cutUp = cutAt(cutUp, cut, wanted.id);
  }
  return cutUp;
};

/** Clips ours has that the copy lacks. No step brings back what an earlier one cut away. */
const missing = (changes: ReadonlyArray<TimelineChange>) =>
  changes.filter((change) => change.kind === "added").length;

/** How much still differs; a step is kept only when it lowers this. */
const remaining = (changes: ReadonlyArray<TimelineChange>) =>
  changes.reduce((total, change) => {
    if (change.kind === "trimmed") return total + (change.start ? 1 : 0) + (change.end ? 1 : 0);
    if (change.kind === "changed" || change.kind === "trackChanged") {
      return total + change.properties.length;
    }
    return total + 1;
  }, 0);

/** `removeRange` shifts every track it is given, so held tracks are left out and put back. */
const rippleRemove = (
  timeline: Timeline,
  start: number,
  end: number,
  held: ReadonlyArray<string>,
): Timeline => {
  const edit: TimelineEdit = { kind: "removeRange", start, end, ripple: true };
  if (held.length === 0) return applyEdits(timeline, [edit]);
  const shifted = applyEdits(
    {
      ...timeline,
      tracks: {
        ...timeline.tracks,
        children: timeline.tracks.children.filter((track) => !held.includes(track.name)),
      },
    },
    [edit],
  );
  const done = new Map(shifted.tracks.children.map((track) => [track.name, track]));
  return mapTracks(timeline, (track) => done.get(track.name) ?? track);
};

const trackRefs = (timeline: Timeline): ReadonlyMap<string, PushTrack> => {
  const counts = { Video: 0, Audio: 0 };
  return new Map(
    timeline.tracks.children.map((track) => [
      track.name,
      {
        kind: track.kind === "Video" ? "video" : "audio",
        index: ++counts[track.kind],
        name: track.name,
      },
    ]),
  );
};

interface Candidate {
  /** Stable while steps later in the timeline run, so a step that failed is not tried twice. */
  readonly key: string;
  /** Kinds run in this order; within one, the candidate furthest along the timeline first. */
  readonly order: number;
  readonly frame: number;
  /** More than one only where they make sense together and none of them alone. */
  readonly steps: ReadonlyArray<PushStep>;
  readonly apply: (timeline: Timeline) => Timeline;
  /**
   * A cut loses nothing, so it is kept for freeing a missing clip from the one it is part of,
   * even when the freed piece then differs in more ways than the missing one counted for.
   */
  readonly cutsOnly?: boolean;
}

/**
 * The steps that turn `base`, Premiere's last save as it was read here, into `ours`. Nothing is
 * assumed about which edits made ours: the two are diffed, so it holds after a merge as well.
 */
export const pushPlan = (base: Timeline, ours: Timeline): PushPlan => {
  const rate = ours.global_start_time.rate;
  const first = diffTimelines(base, ours);
  if (first.changes.length === 0) return { rate, steps: [], manual: [], text: "" };
  if (base.global_start_time.rate !== rate) {
    return finish(
      rate,
      [],
      [
        `The frame rate changed from ${base.global_start_time.rate} to ${rate} fps: set the sequence's rate in Premiere, then pull again.`,
      ],
    );
  }

  const wanted = place(ours);
  const settle = (timeline: Timeline) => adoptIds(timeline, wanted, rate);
  const at = (frame: number): PushTime => ({ frame, seconds: secondsAtFrame(frame, rate) });
  const manual: Array<string> = [];
  // A renamed track keeps its place, so steps can name it as ours does and by its number.
  let working = withIds(base, (id) => id);
  for (const change of first.changes) {
    if (change.kind !== "trackRenamed") continue;
    manual.push(changeSentence(change, rate));
    working = mapTracks(working, (track) =>
      track.name === change.before ? { ...track, name: change.after } : track,
    );
  }
  working = settle(working);

  const steps: Array<PushStep> = [];
  const describe = (item: Placed, tracks: ReadonlyMap<string, PushTrack>): PushClip => ({
    name: item.clip.name,
    track: tracks.get(item.track) ?? { kind: "video", index: 0, name: item.track },
    start: at(item.start),
    end: at(item.end),
  });

  /** Tries candidates in order until none is left, keeping each that brings `view` closer. */
  const run = (
    view: (timeline: Timeline) => ReadonlyArray<TimelineChange>,
    candidatesOf: (changes: ReadonlyArray<TimelineChange>) => ReadonlyArray<Candidate>,
    retryAfterProgress: boolean,
  ) => {
    const failed = new Set<string>();
    let changes = view(working);
    for (;;) {
      const [candidate] = candidatesOf(changes)
        .filter((entry) => !failed.has(entry.key))
        .toSorted((a, b) => a.order - b.order || b.frame - a.frame);
      if (candidate === undefined) return;
      const next = settle(candidate.apply(working));
      const after = view(next);
      const closer =
        candidate.cutsOnly === true
          ? missing(after) < missing(changes)
          : remaining(after) < remaining(changes) && missing(after) <= missing(changes);
      if (!closer) {
        failed.add(candidate.key);
        continue;
      }
      steps.push(...candidate.steps);
      working = next;
      changes = after;
      if (retryAfterProgress) failed.clear();
    }
  };

  /**
   * Ripples first and from the end: none of them moves anything a later step still names. Every
   * track shifts, which is what Premiere's ripple does unasked, unless `holding` the tracks the
   * diff saw stay put.
   */
  const ripples = (holding: boolean) =>
    run(
      (timeline) => diffTimelines(precut(timeline, wanted, rate), ours).changes,
      (changes) => {
        const tracks = trackRefs(working);
        const clips = place(working);
        return changes.flatMap((change): Array<Candidate> => {
          const range =
            change.kind === "rippled" && change.byFrames < 0
              ? {
                  start: change.fromFrame + change.byFrames,
                  end: change.fromFrame,
                  held: change.heldTracks,
                }
              : // One clip pulled earlier on its own track may be the only clip after a cut.
                change.kind === "moved" &&
                  change.before.track === change.after.track &&
                  change.after.startFrame < change.before.startFrame
                ? { start: change.after.startFrame, end: change.before.startFrame, held: [] }
                : undefined;
          if (range === undefined || range.start < 0) return [];
          const { start, end } = range;
          const held = holding ? range.held : [];
          if (holding && held.length === 0) return [];
          return [
            {
              key: `${start}-${end}`,
              order: 0,
              frame: end,
              steps: [
                {
                  kind: "rippleRemove",
                  start: at(start),
                  end: at(end),
                  tracks: [...tracks.values()].filter(
                    (track) =>
                      !held.includes(track.name) &&
                      clips.some((item) => item.track === track.name && item.end > start),
                  ),
                  heldTracks: held.flatMap((name) => tracks.get(name) ?? []),
                },
              ],
              apply: (timeline) => rippleRemove(timeline, start, end, held),
            },
          ];
        });
      },
      false,
    );
  // A track can look held only because its clips shift at another cut, so holding comes last.
  ripples(false);
  ripples(true);

  run(
    (timeline) => diffTimelines(timeline, ours).changes,
    (changes) => {
      const tracks = trackRefs(working);
      const clips = place(working);
      const byId = new Map(clips.map((item) => [item.id, item]));
      const edit = (edits: ReadonlyArray<TimelineEdit>) => (timeline: Timeline) =>
        applyEdits(timeline, edits);
      return changes.flatMap((change): Array<Candidate> => {
        if (change.kind === "added") {
          const piece = wanted.find((item) => item.id === change.after.id);
          const cut = piece === undefined ? undefined : cutFor(clips, piece, rate);
          if (cut === undefined) return [];
          return [
            {
              key: `split:${cut.parent.id}:${cut.frame}`,
              order: 1,
              frame: cut.frame,
              steps: [{ kind: "split", clip: describe(cut.parent, tracks), at: at(cut.frame) }],
              apply: (timeline) => cutAt(timeline, cut, change.after.id),
              cutsOnly: true,
            },
          ];
        }
        if (change.kind === "rippled" && change.byFrames > 0) {
          // Nothing in Premiere opens time up in one go: each clip moves, the last one first.
          const moving = change.clipIds
            .flatMap((id) => byId.get(id) ?? [])
            .toSorted((a, b) => b.start - a.start);
          const [last] = moving;
          if (last === undefined) return [];
          return [
            {
              key: `open:${change.fromFrame}:${change.byFrames}`,
              order: 4,
              frame: last.start,
              steps: moving.map((item) => {
                const clip = describe(item, tracks);
                return {
                  kind: "move",
                  clip,
                  toTrack: clip.track,
                  toStart: at(item.start + change.byFrames),
                };
              }),
              apply: edit(
                moving.map((item) => ({
                  kind: "move",
                  clipId: item.id,
                  toTrack: item.track,
                  startFrame: item.start + change.byFrames,
                })),
              ),
            },
          ];
        }
        if (
          change.kind !== "removed" &&
          change.kind !== "trimmed" &&
          change.kind !== "moved" &&
          change.kind !== "changed"
        ) {
          return [];
        }
        const item = byId.get(change.before.id);
        if (item === undefined) return [];
        const clip = describe(item, tracks);
        const clipId = item.id;
        switch (change.kind) {
          case "removed":
            return [
              {
                key: `remove:${clipId}`,
                order: 2,
                frame: item.start,
                steps: [{ kind: "remove", clip }],
                apply: edit([{ kind: "delete", clipId }]),
              },
            ];
          case "trimmed":
            return (["end", "start"] as const).flatMap((edge) => {
              const frames = change[edge];
              if (frames === undefined) return [];
              // In or out, the new source point is as far into the clip as the new edge is.
              const into = secondsAtFrame(frames.after - item.start, rate);
              return [
                {
                  key: `trim:${clipId}:${edge}`,
                  order: 3,
                  frame: item.start,
                  steps: [
                    {
                      kind: "trim" as const,
                      clip,
                      edge,
                      to: at(frames.after),
                      sourceSeconds: isStill(item.clip)
                        ? null
                        : Math.round((sourceSeconds(item.clip) + into) * 1e6) / 1e6,
                    },
                  ],
                  apply: edit([{ kind: "trim", clipId, edge, frame: frames.after }]),
                },
              ];
            });
          case "moved": {
            const toTrack = tracks.get(change.after.track);
            if (toTrack === undefined || toTrack.kind !== clip.track.kind) return [];
            const startFrame = change.after.startFrame;
            return [
              {
                key: `move:${clipId}`,
                order: 4,
                frame: item.start,
                steps: [{ kind: "move", clip, toTrack, toStart: at(startFrame) }],
                apply: edit([{ kind: "move", clipId, toTrack: toTrack.name, startFrame }]),
              },
            ];
          }
          case "changed": {
            if (!change.properties.includes("enabled")) return [];
            const enabled = !item.clip.enabled;
            return [
              {
                key: `enable:${clipId}`,
                order: 5,
                frame: item.start,
                steps: [{ kind: "setEnabled", clip, enabled }],
                apply: edit([{ kind: "setEnabled", clipId, enabled }]),
              },
            ];
          }
        }
      });
    },
    true,
  );

  for (const change of diffTimelines(working, ours).changes) {
    if (change.kind !== "added") {
      manual.push(changeSentence(change, rate));
      continue;
    }
    const piece = wanted.find((item) => item.id === change.after.id);
    const { after } = change;
    const source =
      piece === undefined || isStill(piece.clip)
        ? ""
        : `, source in ${stamp(Math.round(sourceSeconds(piece.clip) * 1e6) / 1e6)} of ${targetOf(piece.clip)}`;
    manual.push(
      `Add ${after.name} to ${after.track} at ${stamp(secondsAtFrame(after.startFrame, rate))}-${stamp(secondsAtFrame(after.endFrame, rate))} (frames ${after.startFrame}-${after.endFrame}${source}); import its media first if the project lacks it`,
    );
  }
  return finish(rate, steps, manual);
};

/** At least milliseconds, and microseconds where a frame doesn't land on one. */
const stamp = (seconds: number) => `${seconds.toFixed(6).replace(/0{1,3}$/, "")}s`;

const where = (clip: PushClip) =>
  `${JSON.stringify(clip.name)} on ${clip.track.name} at ${stamp(clip.start.seconds)}`;

const stepLine = (step: PushStep): string => {
  switch (step.kind) {
    case "rippleRemove": {
      const names = (tracks: ReadonlyArray<PushTrack>) => tracks.map((t) => t.name).join(",");
      const held =
        step.heldTracks.length === 0
          ? ""
          : `; keep ${names(step.heldTracks)} in place (lock first)`;
      return `ripple-remove ${stamp(step.start.seconds)}-${stamp(step.end.seconds)} (frames ${step.start.frame}-${step.end.frame}) on ${names(step.tracks)}${held}`;
    }
    case "remove":
      return `remove ${where(step.clip)}-${stamp(step.clip.end.seconds)} (frames ${step.clip.start.frame}-${step.clip.end.frame}), leaving its gap open`;
    case "trim": {
      const from = step.clip[step.edge];
      const source =
        step.sourceSeconds === null
          ? "a still: set its length"
          : `source ${step.edge === "start" ? "in" : "out"} ${stamp(step.sourceSeconds)}`;
      return `trim ${step.edge} of ${where(step.clip)}: ${stamp(from.seconds)} → ${stamp(step.to.seconds)} (frames ${from.frame} → ${step.to.frame}; ${source})`;
    }
    case "move":
      return `move ${where(step.clip)} → ${step.toTrack.name} at ${stamp(step.toStart.seconds)} (frames ${step.clip.start.frame} → ${step.toStart.frame})`;
    case "setEnabled":
      return `${step.enabled ? "enable" : "disable"} ${where(step.clip)} (frame ${step.clip.start.frame})`;
    case "split":
      return `split ${where(step.clip)}: cut at ${stamp(step.at.seconds)} (frame ${step.at.frame})`;
  }
};

const finish = (
  rate: number,
  steps: ReadonlyArray<PushStep>,
  manual: ReadonlyArray<string>,
): PushPlan => ({
  rate,
  steps,
  manual,
  text: [
    ...steps.map((step, index) => `${index + 1}. ${stepLine(step)}`),
    ...(manual.length === 0
      ? []
      : ["By hand, no step here does it safely:", ...manual.map((line) => `- ${line}`)]),
  ].join("\n"),
});
