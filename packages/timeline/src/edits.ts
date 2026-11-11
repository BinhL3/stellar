/**
 * Hand edits (move, trim, delete) as pure operations, so the UI can show them pending and write
 * the result on commit. Times are whole timeline frames. Moves overwrite what they land on, as
 * an editor's drag does; trims stop at the neighbouring clip and the media's first frame.
 */
import { layoutTimeline } from "./layout.ts";
import {
  type Clip,
  type Gap,
  rationalTime,
  type Timeline,
  TIMELINE_NAMESPACE,
  timeRange,
  type TrackChild,
} from "./otio.ts";

export type TimelineEdit =
  | {
      readonly kind: "move";
      readonly clipId: string;
      readonly toTrack: string;
      readonly startFrame: number;
      /**
       * Magnetic, like CapCut's main-track magnet: the clip's old place closes up on its track,
       * and it drops in at the nearest clip boundary, pushing later clips along instead of
       * overwriting them. Only the two tracks involved move.
       */
      readonly magnetic?: boolean;
    }
  | {
      readonly kind: "trim";
      readonly clipId: string;
      readonly edge: "start" | "end";
      readonly frame: number;
    }
  | { readonly kind: "delete"; readonly clipId: string }
  /** Closes the gap the clip leaves on every track; skipped when that would cut another clip. */
  | { readonly kind: "rippleDelete"; readonly clipId: string }
  /** Cuts every clip crossing `frame`, on the named tracks or on all of them. */
  | { readonly kind: "split"; readonly frame: number; readonly tracks?: ReadonlyArray<string> }
  /** Clears [start, end) on every track; `ripple` then pulls later clips left (Premiere's extract). */
  | {
      readonly kind: "removeRange";
      readonly start: number;
      readonly end: number;
      readonly ripple: boolean;
    }
  | { readonly kind: "setEnabled"; readonly clipId: string; readonly enabled: boolean }
  /** New words for a text graphic; its style stays in the native blob. */
  | { readonly kind: "setText"; readonly clipId: string; readonly text: string };

/** The clip an edit is about, if it is about one clip. */
export const editClipId = (edit: TimelineEdit): string | null =>
  "clipId" in edit ? edit.clipId : null;

interface Placed {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly clip: Clip;
}

/** Stills and graphics have no source time: only their length means anything. */
export const STILL_PATH = /\.(png|jpe?g|heic|tiff?|psd|gif|webp|bmp)$/i;

const withMetadata = (clip: Clip, start: number, end: number, id?: string): Clip => {
  const premiere = clip.metadata["premiere"] as Record<string, unknown> | undefined;
  const stellar = (clip.metadata[TIMELINE_NAMESPACE] as Record<string, unknown> | undefined) ?? {};
  return {
    ...clip,
    metadata: {
      ...clip.metadata,
      ...(id === undefined ? {} : { [TIMELINE_NAMESPACE]: { ...stellar, id } }),
      // The compact view reads record times from here, so they follow the edit.
      ...(premiere
        ? { premiere: { ...premiere, record: { startFrame: start, endFrame: end } } }
        : {}),
    },
  };
};

/** Shifts a clip's source in point by `frames` timeline frames and sets its new length. */
const reslice = (clip: Clip, rate: number, shiftFrames: number, lengthFrames: number): Clip => {
  const { start_time, duration } = clip.source_range;
  const still =
    clip.media_references.DEFAULT_MEDIA.target_url === "" ||
    STILL_PATH.test(clip.media_references.DEFAULT_MEDIA.target_url);
  const toSource = start_time.rate / rate;
  const start = still ? start_time.value : start_time.value + shiftFrames * toSource;
  const length = lengthFrames * (duration.rate / rate);
  return {
    ...clip,
    source_range: timeRange(
      Math.round(start * 1000) / 1000,
      Math.round(length * 1000) / 1000,
      start_time.rate,
    ),
  };
};

const placedTracks = (timeline: Timeline) => {
  const layout = layoutTimeline(timeline);
  return timeline.tracks.children.map((track) => {
    const laid = layout.tracks.find((t) => t.name === track.name);
    const placed: Array<Placed> = (laid?.clips ?? []).map((item) => ({
      id: item.key,
      start: Math.round(item.startFrame),
      end: Math.round(item.endFrame),
      clip: item.clip,
    }));
    return { track, placed };
  });
};

/** Clears [start, end) on a track: covered clips go, clips across an edge are trimmed or split. */
const overwrite = (placed: Array<Placed>, start: number, end: number, rate: number) => {
  const kept: Array<Placed> = [];
  for (const item of placed) {
    if (item.end <= start || item.start >= end) {
      kept.push(item);
      continue;
    }
    if (item.start < start) {
      kept.push({
        ...item,
        end: start,
        clip: reslice(item.clip, rate, 0, start - item.start),
      });
    }
    if (item.end > end) {
      const tailId = item.start < start ? `${item.id}~${end}` : item.id;
      kept.push({
        id: tailId,
        start: end,
        end: item.end,
        clip: reslice(item.clip, rate, end - item.start, item.end - end),
      });
    }
  }
  placed.splice(0, placed.length, ...kept);
};

const rebuild = (placed: ReadonlyArray<Placed>, rate: number): Array<TrackChild> => {
  const children: Array<TrackChild> = [];
  let cursor = 0;
  for (const item of placed.toSorted((a, b) => a.start - b.start)) {
    if (item.start > cursor) {
      const gap: Gap = {
        OTIO_SCHEMA: "Gap.1",
        name: "",
        source_range: timeRange(0, item.start - cursor, rate),
        enabled: true,
        metadata: {},
      };
      children.push(gap);
    }
    children.push(withMetadata(item.clip, item.start, item.end, item.id));
    cursor = Math.max(cursor, item.end);
  }
  return children;
};

type PlacedTracks = ReturnType<typeof placedTracks>;

const shiftAfter = (tracks: PlacedTracks, from: number, by: number) => {
  for (const { placed } of tracks) {
    for (const [index, item] of placed.entries()) {
      if (item.start >= from)
        placed[index] = { ...item, start: item.start - by, end: item.end - by };
    }
  }
};

/** True when another track has a clip inside [start, end), so closing that gap would cut it. */
const gapIsShared = (tracks: PlacedTracks, start: number, end: number, except: string) =>
  tracks.some(({ placed }) =>
    placed.some((item) => item.id !== except && item.start < end && item.end > start),
  );

const applyRangeEdit = (tracks: PlacedTracks, edit: TimelineEdit, rate: number): boolean => {
  if (edit.kind === "split") {
    const frame = Math.round(edit.frame);
    for (const { track, placed } of tracks) {
      if (edit.tracks && !edit.tracks.includes(track.name)) continue;
      const kept: Array<Placed> = [];
      for (const item of placed) {
        if (item.start >= frame || item.end <= frame) {
          kept.push(item);
          continue;
        }
        kept.push({ ...item, end: frame, clip: reslice(item.clip, rate, 0, frame - item.start) });
        kept.push({
          id: `${item.id}~${frame}`,
          start: frame,
          end: item.end,
          clip: reslice(item.clip, rate, frame - item.start, item.end - frame),
        });
      }
      placed.splice(0, placed.length, ...kept);
    }
    return true;
  }
  if (edit.kind === "removeRange") {
    const start = Math.round(Math.min(edit.start, edit.end));
    const end = Math.round(Math.max(edit.start, edit.end));
    if (end <= start) return true;
    for (const { placed } of tracks) overwrite(placed, start, end, rate);
    if (edit.ripple) shiftAfter(tracks, end, end - start);
    return true;
  }
  return false;
};

/** Whether a ripple delete of `clipId` would have to cut a clip on another track. */
export const rippleDeleteBlocked = (timeline: Timeline, clipId: string): boolean => {
  const tracks = placedTracks(timeline);
  const item = tracks.flatMap((t) => t.placed).find((p) => p.id === clipId);
  return item === undefined || gapIsShared(tracks, item.start, item.end, clipId);
};

const applyOne = (tracks: PlacedTracks, edit: TimelineEdit, rate: number) => {
  if (applyRangeEdit(tracks, edit, rate)) return;
  if (!("clipId" in edit)) return;
  const from = tracks.find((t) => t.placed.some((p) => p.id === edit.clipId));
  const item = from?.placed.find((p) => p.id === edit.clipId);
  if (from === undefined || item === undefined) return;
  const others = from.placed.filter((p) => p !== item);

  if (edit.kind === "delete") {
    from.placed.splice(0, from.placed.length, ...others);
    return;
  }

  if (edit.kind === "rippleDelete") {
    if (gapIsShared(tracks, item.start, item.end, item.id)) return;
    from.placed.splice(0, from.placed.length, ...others);
    shiftAfter(tracks, item.end, item.end - item.start);
    return;
  }

  if (edit.kind === "setText") {
    const stellar = (item.clip.metadata[TIMELINE_NAMESPACE] as Record<string, unknown>) ?? {};
    from.placed.splice(0, from.placed.length, ...others, {
      ...item,
      clip: {
        ...item.clip,
        metadata: { ...item.clip.metadata, [TIMELINE_NAMESPACE]: { ...stellar, text: edit.text } },
      },
    });
    return;
  }

  if (edit.kind === "setEnabled") {
    from.placed.splice(0, from.placed.length, ...others, {
      ...item,
      clip: { ...item.clip, enabled: edit.enabled },
    });
    return;
  }

  if (edit.kind === "trim") {
    if (edit.edge === "start") {
      const previous = Math.max(0, ...others.filter((p) => p.end <= item.start).map((p) => p.end));
      const { start_time } = item.clip.source_range;
      // A trim can't reach before the media's first frame.
      const sourceFloor = item.start - Math.floor((start_time.value / start_time.rate) * rate);
      const floor = STILL_PATH.test(item.clip.media_references.DEFAULT_MEDIA.target_url)
        ? previous
        : Math.max(previous, sourceFloor);
      const start = Math.min(Math.max(Math.round(edit.frame), floor), item.end - 1);
      const trimmed = reslice(item.clip, rate, start - item.start, item.end - start);
      from.placed.splice(0, from.placed.length, ...others, { ...item, start, clip: trimmed });
    } else {
      const next = Math.min(
        Number.POSITIVE_INFINITY,
        ...others.filter((p) => p.start >= item.end).map((p) => p.start),
      );
      const end = Math.max(Math.min(Math.round(edit.frame), next), item.start + 1);
      const trimmed = reslice(item.clip, rate, 0, end - item.start);
      from.placed.splice(0, from.placed.length, ...others, { ...item, end, clip: trimmed });
    }
    return;
  }

  if (edit.kind !== "move") return;
  const to = tracks.find((t) => t.track.name === edit.toTrack);
  if (to === undefined || to.track.kind !== from.track.kind) return;
  if (edit.magnetic === true) {
    const length = item.end - item.start;
    from.placed.splice(0, from.placed.length, ...others);
    for (const [index, other] of from.placed.entries()) {
      if (other.start >= item.end) {
        from.placed[index] = { ...other, start: other.start - length, end: other.end - length };
      }
    }
    let at = Math.max(0, Math.round(edit.startFrame));
    const covering = to.placed.find((other) => other.start < at && other.end > at);
    if (covering) at = at - covering.start < covering.end - at ? covering.start : covering.end;
    const next = Math.min(
      Number.POSITIVE_INFINITY,
      ...to.placed.filter((other) => other.start >= at).map((other) => other.start),
    );
    const push = Math.max(0, at + length - next);
    if (push > 0) {
      for (const [index, other] of to.placed.entries()) {
        if (other.start >= at) {
          to.placed[index] = { ...other, start: other.start + push, end: other.end + push };
        }
      }
    }
    to.placed.push({ ...item, start: at, end: at + length });
    return;
  }
  const start = Math.max(0, Math.round(edit.startFrame));
  const end = start + (item.end - item.start);
  from.placed.splice(0, from.placed.length, ...others);
  overwrite(to.placed, start, end, rate);
  to.placed.push({ ...item, start, end });
};

/** The timeline with `edits` applied in order. Edits naming a clip that no longer exists are skipped. */
export const applyEdits = (timeline: Timeline, edits: ReadonlyArray<TimelineEdit>): Timeline => {
  if (edits.length === 0) return timeline;
  const rate = timeline.global_start_time.rate;
  const tracks = placedTracks(timeline);
  for (const edit of edits) applyOne(tracks, edit, rate);
  return {
    ...timeline,
    global_start_time: rationalTime(timeline.global_start_time.value, rate),
    tracks: {
      ...timeline.tracks,
      children: tracks.map(({ track, placed }) => ({ ...track, children: rebuild(placed, rate) })),
    },
  };
};
