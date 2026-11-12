/**
 * Voice-over per script line: a take is an audio file recorded for one beat, and placing a
 * beat's chosen take re-times that beat alone. A beat's clips are found by their media (a take's
 * file), not by metadata, so they are still known after a round trip through Premiere.
 */
import { applyEdits, STILL_PATH, type TimelineEdit } from "./edits.ts";
import { layoutTimeline } from "./layout.ts";
import {
  type Clip,
  type Gap,
  type Timeline,
  TIMELINE_NAMESPACE,
  timeRange,
  type Track,
} from "./otio.ts";
import { alignBeats } from "./script.ts";
import { mediaSpanSeconds, timeScalarOf } from "./speed.ts";
import type { TranscriptWord } from "./words.ts";

export interface VoiceOverTake {
  /** `t<n>`, never reused within a project. */
  readonly id: string;
  readonly beatId: string;
  /** The WAV, relative to the media root with forward slashes, such as "Audio/VO/VO b3 t7.wav". */
  readonly file: string;
  readonly seconds: number;
  readonly source: "recorded" | "imported" | "split";
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

/** Which takes a project has and which one each beat uses. */
export interface VoiceOverIndex {
  readonly takes: ReadonlyArray<VoiceOverTake>;
  /** Beat id to the id of its chosen take; a beat with takes always has one. */
  readonly chosen: Readonly<Record<string, string>>;
  readonly nextId: number;
}

export const NO_TAKES: VoiceOverIndex = { takes: [], chosen: {}, nextId: 1 };

const takeNumber = (id: string) => Number(/^t(\d+)$/.exec(id)?.[1] ?? 0);

/** The id the next take gets. Ids written by hand may be ahead of the counter. */
export const nextTakeId = (index: VoiceOverIndex): string =>
  `t${Math.max(index.nextId, ...index.takes.map((take) => takeNumber(take.id) + 1))}`;

/** Adds a take and chooses it: the newest take of a line is the one in use until another is picked. */
export const addTake = (index: VoiceOverIndex, take: VoiceOverTake): VoiceOverIndex => ({
  takes: [...index.takes.filter((other) => other.id !== take.id), take],
  chosen: { ...index.chosen, [take.beatId]: take.id },
  nextId: Math.max(index.nextId, takeNumber(take.id) + 1),
});

/** The index with `takeId` chosen for its beat, or why it can't be. */
export const chooseTake = (
  index: VoiceOverIndex,
  beatId: string,
  takeId: string,
): VoiceOverIndex | string => {
  const take = index.takes.find((other) => other.id === takeId);
  if (take === undefined) return `no take ${takeId}`;
  if (take.beatId !== beatId)
    return `take ${takeId} was recorded for ${take.beatId}, not ${beatId}`;
  return { ...index, chosen: { ...index.chosen, [beatId]: takeId } };
};

/** The index without `takeId`. A beat that lost its chosen take falls back to its newest one. */
export const removeTake = (index: VoiceOverIndex, takeId: string): VoiceOverIndex | string => {
  const take = index.takes.find((other) => other.id === takeId);
  if (take === undefined) return `no take ${takeId}`;
  const takes = index.takes.filter((other) => other !== take);
  const { [take.beatId]: chosen, ...others } = index.chosen;
  if (chosen !== takeId) return { ...index, takes };
  const fallback = takes
    .filter((other) => other.beatId === take.beatId)
    .toSorted((a, b) => b.createdAt - a.createdAt || takeNumber(b.id) - takeNumber(a.id))[0];
  return {
    ...index,
    takes,
    chosen: fallback === undefined ? others : { ...others, [take.beatId]: fallback.id },
  };
};

interface Placed {
  readonly id: string;
  readonly track: string;
  readonly start: number;
  readonly end: number;
  readonly clip: Clip;
}

/** Every clip in whole timeline frames, by track in file order, with the ids `applyEdits` uses. */
const flatten = (timeline: Timeline) => {
  const layout = layoutTimeline(timeline);
  return timeline.tracks.children.map((track) => ({
    track,
    clips: (layout.tracks.find((laid) => laid.name === track.name)?.clips ?? []).map(
      (item): Placed => ({
        id: item.key,
        track: track.name,
        start: Math.round(item.startFrame),
        end: Math.round(item.endFrame),
        clip: item.clip,
      }),
    ),
  }));
};

const targetOf = (clip: Clip) => clip.media_references.DEFAULT_MEDIA.target_url;

/** A clip's media is a take's file when it names it, relative to the media root or absolute. */
const takeOf = (clip: Clip, takes: ReadonlyArray<VoiceOverTake>) => {
  const target = targetOf(clip).replaceAll("\\", "/");
  return takes.find((take) => target === take.file || target.endsWith(`/${take.file}`));
};

/** Where a beat's voice-over sits on a timeline. */
export interface PlacedVoiceOver {
  readonly beatId: string;
  /** The take its first clip plays. */
  readonly takeId: string;
  readonly track: string;
  readonly startFrame: number;
  readonly endFrame: number;
  /** More than one when a take was cut into pieces, or comes back from Premiere as linked channels. */
  readonly clipIds: ReadonlyArray<string>;
}

/** The voice-over on a timeline by beat: every clip whose media is one of that beat's takes. */
export const placedVoiceOver = (
  timeline: Timeline,
  takes: ReadonlyArray<VoiceOverTake>,
): ReadonlyMap<string, PlacedVoiceOver> => {
  const found = new Map<string, PlacedVoiceOver>();
  const clips = flatten(timeline)
    .flatMap((track) => track.clips)
    .toSorted((a, b) => a.start - b.start);
  for (const item of clips) {
    const take = takeOf(item.clip, takes);
    if (take === undefined) continue;
    const known = found.get(take.beatId);
    found.set(
      take.beatId,
      known === undefined
        ? {
            beatId: take.beatId,
            takeId: take.id,
            track: item.track,
            startFrame: item.start,
            endFrame: item.end,
            clipIds: [item.id],
          }
        : {
            ...known,
            endFrame: Math.max(known.endFrame, item.end),
            clipIds: [...known.clipIds, item.id],
          },
    );
  }
  return found;
};

/** The ids of the takes any clip of a timeline plays. */
export const takesOnTimeline = (
  timeline: Timeline,
  takes: ReadonlyArray<VoiceOverTake>,
): ReadonlySet<string> =>
  new Set(
    flatten(timeline).flatMap((track) =>
      track.clips.flatMap((item) => takeOf(item.clip, takes)?.id ?? []),
    ),
  );

/** A clip that couldn't be stretched as far as the longer take needed. */
export interface ShortClip {
  readonly clipId: string;
  readonly name: string;
  readonly track: string;
  /** Frames of gap left after the clip, starting at `atFrame`. */
  readonly frames: number;
  readonly atFrame: number;
}

export interface VoiceOverPlacement {
  /** The timeline with the take in place. Equal to `applyEdits(prepared, edits)`. */
  readonly timeline: Timeline;
  /**
   * The timeline before any clip moves: the beat's old voice-over clips are gaps, the track
   * exists, and the new clip waits past the end, since no edit adds a clip.
   */
  readonly prepared: Timeline;
  /** The moves and trims that re-time the beat, ripple what follows and bring the take in. */
  readonly edits: ReadonlyArray<TimelineEdit>;
  readonly track: string;
  readonly startFrame: number;
  readonly endFrame: number;
  /** Frames the beat held before; 0 when it had no voice-over and nothing had to make room. */
  readonly previousFrames: number;
  /** How far everything after the beat moved; negative is earlier. */
  readonly movedBy: number;
  /** Clips inside the beat whose place or length changed. */
  readonly retimed: number;
  readonly short: ReadonlyArray<ShortClip>;
}

export interface PlaceTakeInput {
  readonly take: VoiceOverTake;
  /** Every take of the project, to find the voice-over already on the timeline. */
  readonly takes: ReadonlyArray<VoiceOverTake>;
  /** Beat ids in script order; a line with no voice-over yet goes after the nearest earlier one. */
  readonly order: ReadonlyArray<string>;
  /** A media file's length in seconds by `target_url`, where known. */
  readonly mediaSeconds: (target: string) => number | undefined;
}

const gapOf = (clip: Clip): Gap => ({
  OTIO_SCHEMA: "Gap.1",
  name: "",
  source_range: clip.source_range,
  enabled: true,
  metadata: {},
});

/**
 * Places `take` as its beat's voice-over and re-times only that beat; a sentence instead when
 * nothing can be placed. The rules are the comments in the body, and the Voice-over entry of
 * docs/video-editor/DESIGN.md.
 */
export const placeTake = (
  timeline: Timeline,
  input: PlaceTakeInput,
): VoiceOverPlacement | string => {
  const { take } = input;
  const rate = timeline.global_start_time.rate;
  const length = Math.max(1, Math.round(take.seconds * rate));
  const tracks = flatten(timeline);
  const placed = placedVoiceOver(timeline, input.takes);
  const current = placed.get(take.beatId);
  const removed = new Set(current?.clipIds ?? []);
  const kept = tracks.map(({ track, clips }) => ({
    track,
    clips: clips.filter((item) => !removed.has(item.id)).toSorted((a, b) => a.start - b.start),
  }));

  // The beat's range is what its voice-over clips cover now.
  let trackName: string;
  let start: number;
  let end: number;
  let newTrack: Track | null = null;
  if (current !== undefined) {
    trackName = current.track;
    start = current.startFrame;
    end = current.endFrame;
  } else {
    // No voice-over yet: right after the nearest earlier line that has one, else right before
    // the nearest later one, else at frame 0, on that line's track.
    const at = input.order.indexOf(take.beatId);
    if (at < 0) return `${take.beatId} is not a line of the script`;
    const earlier = input.order.slice(0, at).findLast((beatId) => placed.has(beatId));
    const later = input.order.slice(at + 1).find((beatId) => placed.has(beatId));
    const anchor = placed.get(earlier ?? later ?? "");
    const audio = kept.filter(({ track }) => track.kind === "Audio");
    const empty = audio.findLast(({ clips }) => clips.length === 0);
    if (anchor !== undefined) trackName = anchor.track;
    else if (empty !== undefined) trackName = empty.track.name;
    else {
      const names = new Set(tracks.map(({ track }) => track.name));
      let number = audio.length + 1;
      while (names.has(`A${number}`)) number++;
      trackName = `A${number}`;
      newTrack = {
        OTIO_SCHEMA: "Track.1",
        name: trackName,
        kind: "Audio",
        children: [],
        enabled: true,
        metadata: {},
      };
    }
    start = anchor === undefined ? 0 : earlier !== undefined ? anchor.endFrame : anchor.startFrame;
    const next = Math.min(
      Number.POSITIVE_INFINITY,
      ...(kept.find(({ track }) => track.name === trackName)?.clips ?? [])
        .filter((item) => item.end > start)
        .map((item) => Math.max(item.start, start)),
    );
    // Room for the whole take means nothing moves; else the stretch up to the next clip on the
    // track is the beat's range, and is re-timed to fit.
    end = Math.min(start + length, next);
  }
  const previous = end - start;
  const delta = length - previous;
  const inTheWay = (kept.find(({ track }) => track.name === trackName)?.clips ?? []).find(
    (item) => item.start < end && item.end > start,
  );
  if (inTheWay !== undefined) {
    return `${trackName} has another clip (#${inTheWay.id} ${inTheWay.clip.name}) inside this line's voice-over at frames ${inTheWay.start}-${inTheWay.end}; move it to another track first`;
  }

  // Cut points inside the range scale to the take's length, so three shots under a line stay
  // three shots; everything at or after its end moves by the difference; nothing before changes.
  const scaled = (frame: number) => start + Math.round(((frame - start) * length) / previous);
  const startAfter = (frame: number) =>
    frame >= end ? frame + delta : frame <= start ? frame : scaled(frame);
  const endAfter = (frame: number) =>
    frame <= start ? frame : frame >= end ? frame + delta : scaled(frame);
  /**
   * The longest a clip can play from its in point, in timeline frames. Stills stretch freely; a
   * file of unknown length is not extended. A clip that can't reach leaves a gap, listed in `short`.
   * A speed change uses its media that many times faster, and a reversed clip's tail runs toward
   * its media's first frame, which is as far as a trim lets it (`applyEdits`).
   */
  const longest = (item: Placed) => {
    const target = targetOf(item.clip);
    if (target === "" || STILL_PATH.test(target)) return Number.POSITIVE_INFINITY;
    const scalar = timeScalarOf(item.clip);
    const span = mediaSpanSeconds(item.clip);
    if (scalar < 0) return item.end - item.start + Math.floor((span.start * rate) / -scalar);
    const seconds = input.mediaSeconds(target);
    const available =
      seconds === undefined ? 0 : Math.floor(((seconds - span.start) / scalar) * rate + 1e-6);
    return Math.max(item.end - item.start, available);
  };

  const edits: Array<TimelineEdit> = [];
  const expected = new Map<string, { readonly start: number; readonly end: number }>();
  const short: Array<ShortClip> = [];
  let retimed = 0;
  for (const { clips } of kept) {
    const plans = clips.map((item) => {
      const to = startAfter(item.start);
      const wanted = endAfter(item.end) - to;
      const frames = Math.min(wanted, longest(item));
      return { item, to, wanted, frames };
    });
    const vanishing = plans.find((plan) => plan.wanted < 1);
    if (vanishing !== undefined) {
      const { item } = vanishing;
      return `the take is too short for ${item.track} #${item.id} ${item.clip.name} (frames ${item.start}-${item.end}): it would be left with no frames. Move or remove it first`;
    }
    // A clip keeps its in point: it is moved and its tail trimmed or extended, never cut in two.
    // Clips move into space the ones before them in this order have already left.
    for (const { item, to, wanted, frames } of delta > 0 ? plans.toReversed() : plans) {
      expected.set(item.id, { start: to, end: to + frames });
      const before = item.end - item.start;
      if (frames < wanted) {
        short.push({
          clipId: item.id,
          name: item.clip.name,
          track: item.track,
          frames: wanted - frames,
          atFrame: to + frames,
        });
      }
      if (to === item.start && frames === before) continue;
      if (item.start < end) retimed++;
      const move: TimelineEdit = {
        kind: "move",
        clipId: item.id,
        toTrack: item.track,
        startFrame: to,
      };
      const trim = (from: number): TimelineEdit => ({
        kind: "trim",
        clipId: item.id,
        edge: "end",
        frame: from + frames,
      });
      if (frames < before) edits.push(trim(item.start));
      if (to !== item.start) edits.push(move);
      if (frames > before) edits.push(trim(to));
    }
  }

  const existing = new Set(tracks.flatMap(({ clips }) => clips.map((item) => item.id)));
  let id = `vo-${take.beatId}-${take.id}`;
  while (existing.has(id) && !removed.has(id)) id = `${id}+`;
  const clip: Clip = {
    OTIO_SCHEMA: "Clip.2",
    name: take.file.slice(take.file.lastIndexOf("/") + 1),
    source_range: timeRange(0, length, rate),
    media_references: {
      DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: take.file, metadata: {} },
    },
    active_media_reference_key: "DEFAULT_MEDIA",
    enabled: true,
    metadata: { [TIMELINE_NAMESPACE]: { id } },
  };
  // Parked where no ripple can reach it, then moved in once the room is there.
  const far =
    Math.max(0, ...tracks.flatMap(({ clips }) => clips.map((item) => item.end))) +
    Math.abs(delta) +
    length;
  const children = [...timeline.tracks.children, ...(newTrack === null ? [] : [newTrack])].map(
    (track): Track => {
      const laid = tracks.find((other) => other.track === track);
      const own = track.children.map((child) =>
        child.OTIO_SCHEMA === "Clip.2" &&
        laid?.clips.some((item) => item.clip === child && removed.has(item.id))
          ? gapOf(child)
          : child,
      );
      if (track.name !== trackName) return { ...track, children: own };
      const trackEnd = Math.max(0, ...(laid?.clips ?? []).map((item) => item.end));
      const parked: Gap = {
        OTIO_SCHEMA: "Gap.1",
        name: "",
        source_range: timeRange(0, far - trackEnd, rate),
        enabled: true,
        metadata: {},
      };
      return { ...track, children: [...own, parked, clip] };
    },
  );
  const prepared: Timeline = { ...timeline, tracks: { ...timeline.tracks, children } };
  edits.push({ kind: "move", clipId: id, toTrack: trackName, startFrame: start });
  expected.set(id, { start, end: start + length });

  const result = applyEdits(prepared, edits);
  const after = new Map(
    flatten(result).flatMap((track) => track.clips.map((item) => [item.id, item] as const)),
  );
  // Moves overwrite what they land on, so a wrong step would cut a clip without saying so.
  const wrong =
    after.size !== expected.size ||
    [...expected].some(([clipId, place]) => {
      const landed = after.get(clipId);
      return landed === undefined || landed.start !== place.start || landed.end !== place.end;
    });
  if (wrong) return "the clips around this line can't be re-timed without cutting one of them";

  return {
    timeline: result,
    prepared,
    edits,
    track: trackName,
    startFrame: start,
    endFrame: start + length,
    previousFrames: previous,
    movedBy: delta,
    retimed,
    short,
  };
};

/** One beat's stretch of a longer recording, in seconds of that recording. */
export interface TakeSlice {
  readonly beatId: string;
  readonly start: number;
  readonly end: number;
  /** The beat's words, timed from the slice's start. */
  readonly words: ReadonlyArray<TranscriptWord>;
}

// Breath kept around a line's words when the neighbouring words leave room for it.
const SLICE_LEAD = 0.15;
const SLICE_TAIL = 0.3;

/**
 * Cuts a recording of several lines into one slice per beat that is said in it, by matching
 * each beat's words against the recording's transcript (`alignBeats`). A slice ends halfway to
 * the neighbouring word at most, so no slice holds another line's words.
 */
export const sliceByBeats = (
  beats: ReadonlyArray<{ readonly id: string; readonly text: string }>,
  words: ReadonlyArray<TranscriptWord>,
): Array<TakeSlice> => {
  // Aligned in milliseconds, as whole "frames".
  const aligned = alignBeats(beats, {
    name: "",
    rate: 1000,
    count: words.length,
    clips: [
      {
        track: "",
        clipId: "",
        name: "",
        startFrame: 0,
        endFrame: Math.round((words.at(-1)?.end ?? 0) * 1000),
        words: words.map((word, index) => ({
          index: index + 1,
          word: word.w,
          startFrame: Math.round(word.start * 1000),
          endFrame: Math.round(word.end * 1000),
        })),
      },
    ],
  });
  return aligned.flatMap((beat): Array<TakeSlice> => {
    const first = words[(beat.firstWord ?? 0) - 1];
    const last = words[(beat.lastWord ?? 0) - 1];
    if (beat.firstWord === null || beat.lastWord === null || !first || !last) return [];
    const before = words[beat.firstWord - 2];
    const after = words[beat.lastWord];
    const milli = (value: number) => Math.round(value * 1000) / 1000;
    const start = milli(
      Math.max(
        0,
        first.start - SLICE_LEAD,
        before === undefined ? 0 : (before.end + first.start) / 2,
      ),
    );
    const end = milli(
      Math.min(
        last.end + SLICE_TAIL,
        after === undefined ? Number.POSITIVE_INFINITY : (last.end + after.start) / 2,
      ),
    );
    return [
      {
        beatId: beat.id,
        start,
        end,
        words: words.slice(beat.firstWord - 1, beat.lastWord).map((word) => ({
          w: word.w,
          start: milli(word.start - start),
          end: milli(word.end - start),
        })),
      },
    ];
  });
};
