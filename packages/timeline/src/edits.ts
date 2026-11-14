/**
 * Hand edits as pure operations, in whole timeline frames, so the UI can show them pending.
 * Moves overwrite what they land on; trims stop at the neighbour and the media's first frame.
 * Ripple, roll, slip and slide carry a clip's linked partner: see `linkedGroup`.
 */
import { layoutTimeline } from "./layout.ts";
import {
  applyMarkerEdit,
  isMarkerEdit,
  type MarkerEdit,
  type MarkerHost,
  rippleMarkers,
  shiftMarkersFrom,
} from "./markers.ts";
import {
  type Clip,
  type Gap,
  rationalTime,
  type Timeline,
  TIMELINE_NAMESPACE,
  timeRange,
  type TrackChild,
} from "./otio.ts";
import { STILL_PATH } from "./proxies.ts";
import { mediaSpanSeconds, reslicedSourceStart, timeScalarOf } from "./speed.ts";

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
  /**
   * Premiere's ripple edit: the edge goes to `frame` as a trim would, the clip keeps its start,
   * and everything after it on every track moves by the change in length.
   */
  | {
      readonly kind: "rippleTrim";
      readonly clipId: string;
      readonly edge: "start" | "end";
      readonly frame: number;
    }
  /** Premiere's rolling edit: the cut at the edge moves to `frame`, trimming both clips at it. */
  | {
      readonly kind: "roll";
      readonly clipId: string;
      readonly edge: "start" | "end";
      readonly frame: number;
    }
  /** Plays `frames` later in its media (earlier when negative), in the same place. */
  | { readonly kind: "slip"; readonly clipId: string; readonly frames: number }
  /** Moves `frames` along its track; the clips either side trim so the cuts stay closed. */
  | { readonly kind: "slide"; readonly clipId: string; readonly frames: number }
  | { readonly kind: "delete"; readonly clipId: string }
  /**
   * Closes the gap the clip and its linked partner leave on every track; skipped when that
   * would cut another clip.
   */
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
  | { readonly kind: "setText"; readonly clipId: string; readonly text: string }
  /** Notes on the sequence or on a clip; see `markers.ts`. */
  | MarkerEdit;

/** The clip an edit is about, if it is about one clip. */
export const editClipId = (edit: TimelineEdit): string | null =>
  "clipId" in edit ? (edit.clipId ?? null) : null;

interface Placed {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly clip: Clip;
}

/** Stills and graphics have no source time: only their length means anything. */
export { STILL_PATH };

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

type Keyframes = Readonly<Record<string, ReadonlyArray<readonly [number, ...Array<unknown>]>>>;

/** `holder` (a clip's transform, or one effect's params) with its keyframes `seconds` earlier. */
const earlier = <Holder extends { readonly keyframes?: unknown }>(
  holder: Holder,
  seconds: number,
): Holder => {
  if (holder.keyframes === undefined || holder.keyframes === null) return holder;
  const keyframes = Object.fromEntries(
    Object.entries(holder.keyframes as Keyframes).map(([param, points]) => [
      param,
      points.map(([at, ...rest]) => [Math.round((at - seconds) * 1e4) / 1e4, ...rest]),
    ]),
  );
  return { ...holder, keyframes };
};

/**
 * Keyframes are timed from a clip's first frame, so a clip that loses `seconds` off its head
 * has them moved that much earlier, in `transform` and in each effect's `params`: the animation
 * stays on its frames, as in Premiere. Ones now before the clip stay to be eased from.
 */
export const keyframesEarlier = (clip: Clip, seconds: number): Clip => {
  const stellar = clip.metadata[TIMELINE_NAMESPACE] as
    | {
        readonly transform?: { readonly keyframes?: unknown };
        readonly effects?: ReadonlyArray<{ readonly params?: { readonly keyframes?: unknown } }>;
      }
    | undefined;
  if (stellar === undefined || seconds === 0) return clip;
  const animated =
    stellar.transform?.keyframes !== undefined ||
    stellar.effects?.some((effect) => effect.params?.keyframes !== undefined) === true;
  if (!animated) return clip;
  return {
    ...clip,
    metadata: {
      ...clip.metadata,
      [TIMELINE_NAMESPACE]: {
        ...stellar,
        ...(stellar.transform === undefined
          ? {}
          : { transform: earlier(stellar.transform, seconds) }),
        ...(stellar.effects === undefined
          ? {}
          : {
              effects: stellar.effects.map((effect) =>
                effect.params === undefined
                  ? effect
                  : { ...effect, params: earlier(effect.params, seconds) },
              ),
            }),
      },
    },
  };
};

/** Shifts a clip's source in point by `frames` timeline frames and sets its new length. */
const reslice = (clip: Clip, rate: number, shiftFrames: number, lengthFrames: number): Clip => {
  const { start_time, duration } = clip.source_range;
  const still =
    clip.media_references.DEFAULT_MEDIA.target_url === "" ||
    STILL_PATH.test(clip.media_references.DEFAULT_MEDIA.target_url);
  // Speed and direction decide which source frames the kept piece plays.
  const start = still
    ? start_time.value
    : reslicedSourceStart(clip, rate, shiftFrames, lengthFrames);
  const length = lengthFrames * (duration.rate / rate);
  return {
    ...keyframesEarlier(clip, shiftFrames / rate),
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

export interface EditOptions {
  /** A media file's length in seconds, when known, so edits stop where its handles run out. */
  readonly mediaSeconds?: (target: string) => number | undefined;
}

const targetOf = (clip: Clip) => clip.media_references.DEFAULT_MEDIA.target_url;
const hasNoSourceTime = (clip: Clip) => targetOf(clip) === "" || STILL_PATH.test(targetOf(clip));

/**
 * Timeline frames of media a clip leaves unplayed before its first frame (`head`) and after its
 * last (`tail`). Unknown is unlimited; a reversed clip's head plays toward its media's end.
 */
const handlesOf = (clip: Clip, rate: number, options: EditOptions) => {
  if (hasNoSourceTime(clip)) {
    return { head: Number.POSITIVE_INFINITY, tail: Number.POSITIVE_INFINITY };
  }
  const scalar = Math.abs(timeScalarOf(clip));
  const span = mediaSpanSeconds(clip);
  const before = Math.floor((span.start * rate) / scalar + 1e-6);
  const length = options.mediaSeconds?.(targetOf(clip));
  const after =
    length === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(((length - span.end) * rate) / scalar + 1e-6));
  return timeScalarOf(clip) > 0 ? { head: before, tail: after } : { head: after, tail: before };
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

interface Member {
  readonly placed: Array<Placed>;
  readonly item: Placed;
}

const sameSource = (a: Clip, b: Clip) =>
  Math.abs(
    a.source_range.start_time.value / a.source_range.start_time.rate -
      b.source_range.start_time.value / b.source_range.start_time.rate,
  ) < 1e-3;

/**
 * The clip and its linked partners: clips of the other kind (picture for sound, sound for
 * picture) playing the same media from the same source frame over the same timeline frames.
 */
const linkedGroup = (tracks: PlacedTracks, clipId: string): Array<Member> => {
  const own = tracks.find((t) => t.placed.some((p) => p.id === clipId));
  const item = own?.placed.find((p) => p.id === clipId);
  if (own === undefined || item === undefined) return [];
  const group: Array<Member> = [{ placed: own.placed, item }];
  if (hasNoSourceTime(item.clip)) return group;
  for (const { track, placed } of tracks) {
    if (track.kind === own.track.kind) continue;
    const partner = placed.find(
      (p) =>
        p.start === item.start &&
        p.end === item.end &&
        targetOf(p.clip) === targetOf(item.clip) &&
        sameSource(p.clip, item.clip),
    );
    if (partner) group.push({ placed, item: partner });
  }
  return group;
};

/** The track names a clip and its linked partners are on, for cutting them together. */
export const linkedTracks = (timeline: Timeline, clipId: string): Array<string> => {
  const tracks = placedTracks(timeline);
  return linkedGroup(tracks, clipId).map(
    (member) => tracks.find((t) => t.placed === member.placed)?.track.name ?? "",
  );
};

const replace = (placed: Array<Placed>, item: Placed, next: Placed) => {
  const index = placed.indexOf(item);
  if (index >= 0) placed[index] = next;
};

/** The clip touching `item` on the side given, if a clip (not a gap) is there. */
const neighbour = (placed: ReadonlyArray<Placed>, item: Placed, side: "before" | "after") =>
  placed.find(
    (p) => p !== item && (side === "before" ? p.end === item.start : p.start === item.end),
  );

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** A piece with `length` frames that starts `shift` frames later in its playback. */
const resized = (item: Placed, rate: number, start: number, shift: number, length: number) => ({
  ...item,
  start,
  end: start + length,
  clip: reslice(item.clip, rate, shift, length),
});

const rippleTrim = (
  tracks: PlacedTracks,
  edit: Extract<TimelineEdit, { kind: "rippleTrim" }>,
  rate: number,
  markers: MarkerHost,
  options: EditOptions,
) => {
  const group = linkedGroup(tracks, edit.clipId);
  const [first] = group;
  if (first === undefined) return;
  const { start, end } = first.item;
  const frame = Math.round(edit.frame);
  const wanted = edit.edge === "end" ? frame - end : start - frame;
  const inGroup = new Set(group.map((member) => member.item));
  // Clips that move: everything after the clip, on every track.
  const moving = tracks.map(({ placed }) => ({
    placed,
    own: placed.some((p) => inGroup.has(p)),
    after: placed.filter((p) => !inGroup.has(p) && p.start >= end),
    before: placed.filter((p) => !inGroup.has(p) && p.start < end),
  }));
  // Closing up stops where another track's later clips would run into one there that stays.
  const room = Math.min(
    ...moving
      .filter((t) => !t.own && t.after.length > 0)
      .map(
        (t) =>
          Math.min(...t.after.map((p) => p.start)) - Math.max(0, ...t.before.map((p) => p.end)),
      ),
  );
  const handle = Math.min(
    ...group.map(
      ({ item }) => handlesOf(item.clip, rate, options)[edit.edge === "end" ? "tail" : "head"],
    ),
  );
  const change = clamp(wanted, -(end - start - 1), handle);
  const by = Math.max(change, -Math.max(0, room));
  if (by === 0) return;
  for (const { placed, item } of group) {
    replace(
      placed,
      item,
      resized(item, rate, item.start, edit.edge === "end" ? 0 : -by, item.end - item.start + by),
    );
  }
  for (const { placed, after } of moving) {
    for (const item of after)
      replace(placed, item, { ...item, start: item.start + by, end: item.end + by });
  }
  markers.sequence = shiftMarkersFrom(markers.sequence, end, by, rate);
};

const roll = (
  tracks: PlacedTracks,
  edit: Extract<TimelineEdit, { kind: "roll" }>,
  rate: number,
  options: EditOptions,
) => {
  const group = linkedGroup(tracks, edit.clipId);
  const [first] = group;
  if (first === undefined) return;
  const cut = edit.edge === "end" ? first.item.end : first.item.start;
  const wanted = Math.round(edit.frame) - cut;
  // Each track's two sides of the cut: the clip ending at it and the one starting at it.
  const sides = group.map(({ placed, item }) => {
    const left = edit.edge === "end" ? item : neighbour(placed, item, "before");
    const right = edit.edge === "start" ? item : neighbour(placed, item, "after");
    const previousEnd = Math.max(
      0,
      ...placed.filter((p) => p.end <= cut && p !== left).map((p) => p.end),
    );
    const nextStart = Math.min(
      Number.POSITIVE_INFINITY,
      ...placed.filter((p) => p.start >= cut && p !== right).map((p) => p.start),
    );
    return { placed, left, right, previousEnd, nextStart };
  });
  let low = Number.NEGATIVE_INFINITY;
  let high = Number.POSITIVE_INFINITY;
  for (const { left, right, previousEnd, nextStart } of sides) {
    // Without a clip on one side, the cut rolls into the gap there.
    if (left) {
      low = Math.max(low, -(left.end - left.start - 1));
      high = Math.min(high, handlesOf(left.clip, rate, options).tail);
    } else low = Math.max(low, previousEnd - cut);
    if (right) {
      high = Math.min(high, right.end - right.start - 1);
      low = Math.max(low, -handlesOf(right.clip, rate, options).head);
    } else high = Math.min(high, nextStart - cut);
  }
  if (low > high) return;
  const by = clamp(wanted, low, high);
  if (by === 0) return;
  for (const { placed, left, right } of sides) {
    if (left) replace(placed, left, resized(left, rate, left.start, 0, left.end - left.start + by));
    if (right)
      replace(
        placed,
        right,
        resized(right, rate, right.start + by, by, right.end - right.start - by),
      );
  }
};

const slip = (
  tracks: PlacedTracks,
  edit: Extract<TimelineEdit, { kind: "slip" }>,
  rate: number,
  options: EditOptions,
) => {
  const group = linkedGroup(tracks, edit.clipId).filter(({ item }) => !hasNoSourceTime(item.clip));
  if (group.length === 0) return;
  const handles = group.map(({ item }) => handlesOf(item.clip, rate, options));
  const by = clamp(
    Math.round(edit.frames),
    -Math.min(...handles.map((h) => h.head)),
    Math.min(...handles.map((h) => h.tail)),
  );
  if (by === 0) return;
  for (const { placed, item } of group) {
    const length = item.end - item.start;
    const { start_time, duration } = item.clip.source_range;
    // Only the media under the clip changes: its keyframes stay on their frames.
    const sourceStart = reslicedSourceStart(item.clip, rate, by, length);
    replace(placed, item, {
      ...item,
      clip: {
        ...item.clip,
        source_range: timeRange(
          Math.round(sourceStart * 1000) / 1000,
          duration.value,
          start_time.rate,
        ),
      },
    });
  }
};

const slide = (
  tracks: PlacedTracks,
  edit: Extract<TimelineEdit, { kind: "slide" }>,
  rate: number,
  options: EditOptions,
) => {
  const group = linkedGroup(tracks, edit.clipId);
  if (group.length === 0) return;
  const sides = group.map(({ placed, item }) => {
    const left = neighbour(placed, item, "before");
    const right = neighbour(placed, item, "after");
    const previousEnd = Math.max(0, ...placed.filter((p) => p.end <= item.start).map((p) => p.end));
    const nextStart = Math.min(
      Number.POSITIVE_INFINITY,
      ...placed.filter((p) => p.start >= item.end).map((p) => p.start),
    );
    return { placed, item, left, right, previousEnd, nextStart };
  });
  let low = Number.NEGATIVE_INFINITY;
  let high = Number.POSITIVE_INFINITY;
  for (const { item, left, right, previousEnd, nextStart } of sides) {
    if (left) {
      low = Math.max(low, -(left.end - left.start - 1));
      high = Math.min(high, handlesOf(left.clip, rate, options).tail);
    } else low = Math.max(low, previousEnd - item.start);
    if (right) {
      high = Math.min(high, right.end - right.start - 1);
      low = Math.max(low, -handlesOf(right.clip, rate, options).head);
    } else high = Math.min(high, nextStart - item.end);
  }
  if (low > high) return;
  const by = clamp(Math.round(edit.frames), low, high);
  if (by === 0) return;
  for (const { placed, item, left, right } of sides) {
    replace(placed, item, { ...item, start: item.start + by, end: item.end + by });
    if (left) replace(placed, left, resized(left, rate, left.start, 0, left.end - left.start + by));
    if (right)
      replace(
        placed,
        right,
        resized(right, rate, right.start + by, by, right.end - right.start - by),
      );
  }
};

/** The empty stretch of a track around `frame`, between two clips; null over a clip or past the last. */
export const gapAt = (
  timeline: Timeline,
  trackName: string,
  frame: number,
): { readonly start: number; readonly end: number; readonly shared: boolean } | null => {
  const tracks = placedTracks(timeline);
  const placed = tracks.find((t) => t.track.name === trackName)?.placed ?? [];
  if (placed.some((p) => p.start <= frame && p.end > frame)) return null;
  const start = Math.max(0, ...placed.filter((p) => p.end <= frame).map((p) => p.end));
  const end = Math.min(
    Number.POSITIVE_INFINITY,
    ...placed.filter((p) => p.start > frame).map((p) => p.start),
  );
  if (!Number.isFinite(end) || end <= start) return null;
  // Closing it up would cut whatever another track plays there.
  return { start, end, shared: gapIsShared(tracks, start, end, "") };
};

const applyRangeEdit = (
  tracks: PlacedTracks,
  edit: TimelineEdit,
  rate: number,
  markers: MarkerHost,
): boolean => {
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
    if (edit.ripple) {
      shiftAfter(tracks, end, end - start);
      markers.sequence = rippleMarkers(markers.sequence, start, end, rate);
    }
    return true;
  }
  return false;
};

/** Whether a ripple delete of `clipId` would have to cut a clip on another track. */
export const rippleDeleteBlocked = (timeline: Timeline, clipId: string): boolean => {
  const tracks = placedTracks(timeline);
  const group = linkedGroup(tracks, clipId);
  const [first] = group;
  return first === undefined || rippleGapShared(tracks, first.item, group);
};

/** Whether closing up a linked group's frames would cut a clip outside it. */
const rippleGapShared = (tracks: PlacedTracks, item: Placed, group: ReadonlyArray<Member>) => {
  const ids = new Set(group.map((member) => member.item));
  return tracks.some(({ placed }) =>
    placed.some((p) => !ids.has(p) && p.start < item.end && p.end > item.start),
  );
};

const applyOne = (
  tracks: PlacedTracks,
  edit: TimelineEdit,
  rate: number,
  markers: MarkerHost,
  options: EditOptions,
) => {
  if (isMarkerEdit(edit)) {
    applyMarkerEdit(markers, edit, rate);
    return;
  }
  if (applyRangeEdit(tracks, edit, rate, markers)) return;
  switch (edit.kind) {
    case "rippleTrim":
      return rippleTrim(tracks, edit, rate, markers, options);
    case "roll":
      return roll(tracks, edit, rate, options);
    case "slip":
      return slip(tracks, edit, rate, options);
    case "slide":
      return slide(tracks, edit, rate, options);
  }
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
    const group = linkedGroup(tracks, item.id);
    if (rippleGapShared(tracks, item, group)) return;
    for (const member of group) member.placed.splice(member.placed.indexOf(member.item), 1);
    shiftAfter(tracks, item.end, item.end - item.start);
    markers.sequence = rippleMarkers(markers.sequence, item.start, item.end, rate);
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
      const scalar = timeScalarOf(item.clip);
      const sourceFloor =
        item.start - Math.floor(((start_time.value / start_time.rate) * rate) / Math.abs(scalar));
      // A reversed clip's head plays the end of its media, whose length isn't known here.
      const floor =
        STILL_PATH.test(item.clip.media_references.DEFAULT_MEDIA.target_url) || scalar < 0
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
      // A reversed clip's tail plays toward its media's first frame and stops there.
      const { start_time } = item.clip.source_range;
      const scalar = timeScalarOf(item.clip);
      const reverseCeiling =
        scalar < 0 && !STILL_PATH.test(item.clip.media_references.DEFAULT_MEDIA.target_url)
          ? item.end + Math.floor(((start_time.value / start_time.rate) * rate) / -scalar)
          : Number.POSITIVE_INFINITY;
      const end = Math.max(Math.min(Math.round(edit.frame), next, reverseCeiling), item.start + 1);
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
export const applyEdits = (
  timeline: Timeline,
  edits: ReadonlyArray<TimelineEdit>,
  options: EditOptions = {},
): Timeline => {
  if (edits.length === 0) return timeline;
  const rate = timeline.global_start_time.rate;
  const tracks = placedTracks(timeline);
  // Clip markers ride on their clip through every edit; sequence markers are held here.
  const markers: MarkerHost = {
    sequence: timeline.tracks.markers ?? [],
    clips: () => tracks.flatMap(({ placed }) => placed),
    setClip: (id, clip) => {
      for (const { placed } of tracks) {
        for (const [index, item] of placed.entries()) {
          if (item.id === id) placed[index] = { ...item, clip };
        }
      }
    },
  };
  for (const edit of edits) applyOne(tracks, edit, rate, markers, options);
  const { markers: _before, ...stack } = timeline.tracks;
  return {
    ...timeline,
    global_start_time: rationalTime(timeline.global_start_time.value, rate),
    tracks: {
      ...stack,
      children: tracks.map(({ track, placed }) => ({ ...track, children: rebuild(placed, rate) })),
      ...(markers.sequence.length === 0 ? {} : { markers: markers.sequence }),
    },
  };
};
