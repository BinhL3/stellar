/**
 * What changed between two versions of a timeline, and a three-way merge built on it, so the
 * agent's edits and the user's hand edits in Premiere both survive a pull. Pure; frames are
 * whole timeline frames. A line reads `rippled V1,A1 from 240 by -120 (14 clips)`.
 */
import { applyEdits, STILL_PATH, type TimelineEdit } from "./edits.ts";
import { clipIdOf, layoutTimeline } from "./layout.ts";
import { type Clip, sortKeys, type Timeline, TIMELINE_NAMESPACE, type Track } from "./otio.ts";

/** Where a clip sits in one version of the timeline. */
export interface ClipState {
  /** The id edits name the clip by in that version; a re-pull from Premiere can change it. */
  readonly id: string;
  readonly name: string;
  readonly track: string;
  readonly startFrame: number;
  readonly endFrame: number;
}

export interface FrameChange {
  readonly before: number;
  readonly after: number;
}

export type TimelineChange =
  | { readonly kind: "added"; readonly after: ClipState }
  | { readonly kind: "removed"; readonly before: ClipState }
  /** Moved on its own, to another place or track. Clips that only followed a ripple are not listed. */
  | { readonly kind: "moved"; readonly before: ClipState; readonly after: ClipState }
  /**
   * Source in or out changed. `start` and `end` are the edge in `before`'s frames, as a trim edit
   * names it; a ripple that followed the trim is its own change.
   */
  | {
      readonly kind: "trimmed";
      readonly before: ClipState;
      readonly after: ClipState;
      readonly start?: FrameChange;
      readonly end?: FrameChange;
    }
  /** `properties` names what differs: "enabled", "name", "text", "effects", "scale", "scale keyframes"… */
  | {
      readonly kind: "changed";
      readonly before: ClipState;
      readonly after: ClipState;
      readonly properties: ReadonlyArray<string>;
    }
  /**
   * Every clip from `fromFrame` (in the earlier version's frames) on shifted by `byFrames`,
   * negative for earlier. `heldTracks` have later clips that stayed where they were.
   */
  | {
      readonly kind: "rippled";
      readonly tracks: ReadonlyArray<string>;
      readonly heldTracks: ReadonlyArray<string>;
      readonly fromFrame: number;
      readonly byFrames: number;
      /** Ids in the later version. */
      readonly clipIds: ReadonlyArray<string>;
    }
  | { readonly kind: "trackAdded"; readonly track: string; readonly trackKind: Track["kind"] }
  | { readonly kind: "trackRemoved"; readonly track: string; readonly trackKind: Track["kind"] }
  | { readonly kind: "trackRenamed"; readonly before: string; readonly after: string }
  /** `properties` names what differs on the track itself: "enabled", "transitions"… */
  | {
      readonly kind: "trackChanged";
      readonly track: string;
      readonly properties: ReadonlyArray<string>;
    };

export interface TimelineDiff {
  /** Frames per second of the later version, for turning frames into times. */
  readonly rate: number;
  /** Track changes first, then clip changes in timeline order. Empty when nothing changed. */
  readonly changes: ReadonlyArray<TimelineChange>;
}

export interface TimelineViolation {
  readonly kind: "order" | "overlap" | "position" | "duration" | "source";
  readonly track: string;
  /** Null for a gap. */
  readonly clipId: string | null;
  readonly message: string;
}

export interface MergeConflict {
  /** Plain words for the user: what was not applied, and why. */
  readonly message: string;
  /** The change made here (base to ours) that was dropped; Premiere's version stands. */
  readonly change: TimelineChange;
}

export interface TimelineMerge {
  /**
   * Premiere's version, so all that only Premiere understands is kept, plus each change of ours
   * that fits: a delete unless they changed the clip, a trim unless they trimmed that edge, a
   * move unless they moved it, property changes one by one, ripples from the same point.
   */
  readonly timeline: Timeline;
  /**
   * Our changes that were dropped because both sides changed the same thing or ours no longer
   * fits. Not merged at all, theirs stand: gaps, timeline metadata and name. A ripple that is
   * dropped leaves open the gap it would have closed.
   */
  readonly conflicts: ReadonlyArray<MergeConflict>;
}

interface Placed {
  readonly id: string;
  /** False when the id is only the clip's position, which any insert or delete upstream changes. */
  readonly explicit: boolean;
  readonly track: string;
  readonly kind: Track["kind"];
  readonly start: number;
  readonly end: number;
  readonly clip: Clip;
}

interface FlatTrack {
  readonly name: string;
  readonly kind: Track["kind"];
  readonly source: Track;
  readonly clips: ReadonlyArray<Placed>;
}

interface Flat {
  readonly rate: number;
  /** In stack order: V1 upward, then audio. */
  readonly tracks: ReadonlyArray<FlatTrack>;
  readonly clips: ReadonlyArray<Placed>;
}

const flatten = (timeline: Timeline): Flat => {
  const layout = layoutTimeline(timeline);
  const tracks = timeline.tracks.children.map((source): FlatTrack => {
    const laid = layout.tracks.find((track) => track.name === source.name);
    return {
      name: source.name,
      kind: source.kind,
      source,
      clips: (laid?.clips ?? []).map((item) => ({
        id: item.key,
        explicit: clipIdOf(item.clip, "") !== "",
        track: source.name,
        kind: source.kind,
        start: Math.round(item.startFrame),
        end: Math.round(item.endFrame),
        clip: item.clip,
      })),
    };
  });
  return { rate: layout.rate, tracks, clips: tracks.flatMap((track) => track.clips) };
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const same = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

/** `target` with `value` at `path`; an undefined value removes the key. */
const setIn = (target: unknown, path: ReadonlyArray<string>, value: unknown): unknown => {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  const record = isRecord(target) ? target : {};
  const child = setIn(record[key], rest, value);
  if (child !== undefined) return { ...record, [key]: child };
  const { [key]: _removed, ...others } = record;
  return others;
};

interface Property {
  readonly path: ReadonlyArray<string>;
  readonly value: unknown;
}

// Derived from where the clip sits, so they follow moves and trims rather than being changes.
const DERIVED: Readonly<Record<string, ReadonlyArray<string>>> = {
  [TIMELINE_NAMESPACE]: ["id"],
  premiere: ["record", "nodeId", "sourceTicks"],
};

/** What a clip or track carries besides its place, by the name a change reports it under. */
const propertiesOf = (item: Clip | Track): ReadonlyMap<string, Property> => {
  const out = new Map<string, Property>([["enabled", { path: ["enabled"], value: item.enabled }]]);
  if (item.OTIO_SCHEMA === "Clip.2") out.set("name", { path: ["name"], value: item.name });
  const add = (name: string, path: ReadonlyArray<string>, value: unknown) => {
    out.set(out.has(name) ? path.slice(1).join(".") : name, { path, value });
  };
  for (const [namespace, group] of Object.entries(item.metadata)) {
    if (!isRecord(group)) {
      add(namespace, ["metadata", namespace], group);
      continue;
    }
    for (const [key, value] of Object.entries(group)) {
      if (DERIVED[namespace]?.includes(key)) continue;
      const path = ["metadata", namespace, key];
      if (namespace !== TIMELINE_NAMESPACE || key !== "transform" || !isRecord(value)) {
        add(key, path, value);
        continue;
      }
      for (const [param, setting] of Object.entries(value)) {
        if (param !== "keyframes" || !isRecord(setting)) {
          add(param, [...path, param], setting);
          continue;
        }
        for (const [animated, points] of Object.entries(setting)) {
          add(`${animated} keyframes`, [...path, param, animated], points);
        }
      }
    }
  }
  return out;
};

const changedProperties = (before: Clip | Track, after: Clip | Track): Array<string> => {
  const was = propertiesOf(before);
  const is = propertiesOf(after);
  return [...new Set([...was.keys(), ...is.keys()])].filter(
    (name) => !same(was.get(name)?.value, is.get(name)?.value),
  );
};

/** `target` with the named properties as `ours` has them; `base` locates one that ours dropped. */
const carry = <Item extends Clip | Track>(
  target: Item,
  ours: Clip | Track,
  base: Clip | Track,
  names: ReadonlyArray<string>,
): Item => {
  const wanted = propertiesOf(ours);
  const known = propertiesOf(base);
  return names.reduce((patched, name) => {
    const path = wanted.get(name)?.path ?? known.get(name)?.path;
    return path === undefined ? patched : (setIn(patched, path, wanted.get(name)?.value) as Item);
  }, target);
};

const targetOf = (clip: Clip) => clip.media_references.DEFAULT_MEDIA.target_url;
const isStill = (clip: Clip) => targetOf(clip) === "" || STILL_PATH.test(targetOf(clip));
const textOf = (clip: Clip) => propertiesOf(clip).get("text")?.value;

/** A clip's source in and out, in timeline frames. */
const sourceSpan = (clip: Clip, rate: number) => {
  const { start_time, duration } = clip.source_range;
  const start = (start_time.value / start_time.rate) * rate;
  return { start, end: start + (duration.value / duration.rate) * rate };
};

/** How likely two clips of the same media are the same clip; zero when nothing ties them. */
const similarity = (base: Placed, next: Placed, rate: number): number => {
  const sameTrack = base.track === next.track;
  if (isStill(base.clip)) {
    // A still's source range says nothing, so it is known by what it shows or where it sits.
    const alike =
      base.clip.name === next.clip.name &&
      base.end - base.start === next.end - next.start &&
      same(textOf(base.clip), textOf(next.clip));
    const shared = Math.min(base.end, next.end) - Math.max(base.start, next.start);
    const inPlace = sameTrack && shared > 0;
    if (!alike && !inPlace) return 0;
    return (
      (alike ? 2 : 0) +
      (inPlace ? 1 + shared / Math.max(base.end - base.start, next.end - next.start) : 0) +
      (sameTrack ? 0.25 : 0)
    );
  }
  const a = sourceSpan(base.clip, rate);
  const b = sourceSpan(next.clip, rate);
  const shared = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (shared <= 0) return 0;
  return (
    shared / Math.max(a.end - a.start, b.end - b.start) +
    (sameTrack ? 0.5 : 0) +
    (base.start === next.start ? 0.25 : 0) +
    (base.clip.name === next.clip.name ? 0.1 : 0)
  );
};

const mediaKey = (item: Placed) => `${item.kind}|${targetOf(item.clip)}`;

const uniqueById = (clips: ReadonlyArray<Placed>) => {
  const byId = new Map<string, Placed | null>();
  for (const item of clips) byId.set(item.id, byId.has(item.id) ? null : item);
  return byId;
};

/**
 * Pairs each clip with itself in the other version. An id counts only when one side really
 * carries it and the media agrees; Premiere's ids are not promised to survive a save, and
 * positional ids never do, so the rest pair up by media, source overlap, track and name.
 */
const matchClips = (
  base: ReadonlyArray<Placed>,
  next: ReadonlyArray<Placed>,
  rate: number,
): Array<readonly [Placed, Placed]> => {
  const pairs: Array<readonly [Placed, Placed]> = [];
  const taken = new Set<Placed>();
  const baseById = uniqueById(base);
  const nextById = uniqueById(next);
  for (const item of base) {
    const other = nextById.get(item.id);
    if (other === undefined || other === null || baseById.get(item.id) !== item) continue;
    if (!(item.explicit || other.explicit) || mediaKey(item) !== mediaKey(other)) continue;
    pairs.push([item, other]);
    taken.add(item).add(other);
  }

  // A piece an edit cut off (`id~frame`) is new, however much it resembles a clip since removed.
  const cutFrom = (item: Placed, others: ReadonlyMap<string, Placed | null>) =>
    item.id
      .split("~")
      .some((_, parts, all) => parts > 0 && others.has(all.slice(0, parts).join("~")));
  const loose = new Map<string, Array<Placed>>();
  for (const item of next) {
    if (taken.has(item) || cutFrom(item, baseById)) continue;
    loose.set(mediaKey(item), [...(loose.get(mediaKey(item)) ?? []), item]);
  }
  const candidates: Array<{ base: Placed; next: Placed; score: number }> = [];
  for (const item of base) {
    if (taken.has(item) || cutFrom(item, nextById)) continue;
    for (const other of loose.get(mediaKey(item)) ?? []) {
      const score = similarity(item, other, rate);
      if (score > 0) candidates.push({ base: item, next: other, score });
    }
  }
  // The sort is stable, so equally good candidates pair up in timeline order.
  for (const candidate of candidates.toSorted((a, b) => b.score - a.score)) {
    if (taken.has(candidate.base) || taken.has(candidate.next)) continue;
    pairs.push([candidate.base, candidate.next]);
    taken.add(candidate.base).add(candidate.next);
  }
  return pairs;
};

/** Indexes of a longest strictly increasing run; the clips left out changed order. */
const longestRun = (values: ReadonlyArray<number>): ReadonlySet<number> => {
  const tails: Array<number> = [];
  const previous: Array<number> = [];
  values.forEach((value, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((values[tails[middle] ?? 0] ?? 0) < value) low = middle + 1;
      else high = middle;
    }
    previous[index] = low > 0 ? (tails[low - 1] ?? -1) : -1;
    tails[low] = index;
  });
  const kept = new Set<number>();
  for (let at = tails.at(-1) ?? -1; at >= 0; at = previous[at] ?? -1) kept.add(at);
  return kept;
};

interface Pair {
  readonly base: Placed;
  readonly next: Placed;
  /** Frames taken off the head (negative: given back) and added to the tail. */
  readonly trimStart: number;
  readonly trimEnd: number;
  /** Where the clip's start would be in the base once its head trim is applied. */
  readonly from: number;
  /** How far it sits from there. */
  readonly shift: number;
  readonly properties: ReadonlyArray<string>;
}

interface Ripple {
  readonly from: number;
  readonly by: number;
  /** Base track names. */
  readonly tracks: ReadonlyArray<string>;
  readonly held: ReadonlyArray<string>;
  readonly pairs: ReadonlyArray<Pair>;
}

interface Analysis {
  readonly rate: number;
  readonly base: Flat;
  readonly next: Flat;
  readonly pairs: ReadonlyArray<Pair>;
  readonly byBaseId: ReadonlyMap<string, Pair>;
  readonly removed: ReadonlyArray<Placed>;
  readonly added: ReadonlyArray<Placed>;
  /** Pairs that moved on their own rather than with a ripple. */
  readonly moved: ReadonlySet<Pair>;
  /** Ascending by `from`. */
  readonly ripples: ReadonlyArray<Ripple>;
  /** Base track name to its name in `next`; tracks gone from `next` are absent. */
  readonly trackNames: ReadonlyMap<string, string>;
  readonly renames: ReadonlyArray<readonly [string, string]>;
  readonly tracksAdded: ReadonlyArray<FlatTrack>;
  readonly tracksRemoved: ReadonlyArray<FlatTrack>;
  readonly trackChanges: ReadonlyArray<{
    readonly base: FlatTrack;
    readonly next: FlatTrack;
    readonly properties: ReadonlyArray<string>;
  }>;
}

const matchTracks = (
  base: Flat,
  next: Flat,
  matched: ReadonlyArray<readonly [Placed, Placed]>,
): Map<string, string> => {
  const names = new Map<string, string>();
  const has = (flat: Flat, name: string) => flat.tracks.some((track) => track.name === name);
  for (const track of base.tracks) if (has(next, track.name)) names.set(track.name, track.name);
  const taken = new Set<string>();
  base.tracks.forEach((track, index) => {
    if (names.has(track.name)) return;
    const landed = matched.filter(([from]) => from.track === track.name).map(([, to]) => to.track);
    const fresh = next.tracks.filter(
      (other) => other.kind === track.kind && !has(base, other.name) && !taken.has(other.name),
    );
    const count = (name: string) => landed.filter((to) => to === name).length;
    const [best] = fresh.toSorted((a, b) => count(b.name) - count(a.name));
    // Renamed when most of its clips turn up on one new track, or an empty track kept its slot.
    const renamed =
      best !== undefined && count(best.name) * 2 > landed.length
        ? best
        : track.clips.length === 0
          ? fresh.find((other) => other.clips.length === 0 && next.tracks[index] === other)
          : undefined;
    if (renamed === undefined) return;
    names.set(track.name, renamed.name);
    taken.add(renamed.name);
  });
  return names;
};

const pairOf = (base: Placed, next: Placed, rate: number): Pair => {
  const lengthChange = next.end - next.start - (base.end - base.start);
  let trimStart = 0;
  if (isStill(base.clip)) {
    // Stills have no head to trim; a length change is a tail trim unless only the start moved.
    if (lengthChange !== 0 && next.start !== base.start && next.end === base.end) {
      trimStart = -lengthChange;
    }
  } else {
    trimStart = Math.round(sourceSpan(next.clip, rate).start - sourceSpan(base.clip, rate).start);
  }
  const from = base.start + trimStart;
  return {
    base,
    next,
    trimStart,
    trimEnd: trimStart + lengthChange,
    from,
    shift: next.start - from,
    properties: changedProperties(base.clip, next.clip),
  };
};

const analyze = (baseTimeline: Timeline, nextTimeline: Timeline): Analysis => {
  const base = flatten(baseTimeline);
  const next = flatten(nextTimeline);
  const matched = matchClips(base.clips, next.clips, next.rate);
  const trackNames = matchTracks(base, next, matched);
  const pairs = matched.map(([from, to]) => pairOf(from, to, next.rate));
  const moved = new Set<Pair>();
  for (const pair of pairs) {
    if (trackNames.get(pair.base.track) !== pair.next.track) moved.add(pair);
  }

  interface TrackShift {
    readonly track: string;
    readonly from: number;
    /** Where the last clip before the shift ends, so the shift began in (lower, from]. */
    readonly lower: number;
    readonly by: number;
    readonly at: number;
    readonly kept: ReadonlyArray<Pair>;
  }
  const shifts: Array<TrackShift> = [];
  const keptOn = new Map<string, ReadonlyArray<Pair>>();
  for (const track of base.tracks) {
    const staying = pairs
      .filter((pair) => pair.base.track === track.name && !moved.has(pair))
      .toSorted((a, b) => a.from - b.from || a.base.start - b.base.start);
    const ordered = longestRun(staying.map((pair) => pair.next.start));
    const inOrder = staying.filter((pair, index) => {
      if (!ordered.has(index)) moved.add(pair);
      return ordered.has(index);
    });
    const kept: Array<Pair> = [];
    let level = 0;
    let lower = Number.NEGATIVE_INFINITY;
    inOrder.forEach((pair, index) => {
      if (pair.shift !== level) {
        // One clip off the level its neighbours share was moved; a lasting step is a ripple.
        if (inOrder[index + 1]?.shift === level) {
          moved.add(pair);
          return;
        }
        shifts.push({
          track: track.name,
          from: pair.from,
          lower,
          by: pair.shift - level,
          at: kept.length,
          kept,
        });
        level = pair.shift;
      }
      kept.push(pair);
      lower = pair.from + (pair.next.end - pair.next.start);
    });
    keptOn.set(track.name, kept);
  }

  // The same step on several tracks, begun in the same stretch of time, is one ripple.
  const groups: Array<{ by: number; from: number; lower: number; shifts: Array<TrackShift> }> = [];
  for (const shift of shifts.toSorted((a, b) => a.from - b.from)) {
    const group = groups.find(
      (candidate) =>
        candidate.by === shift.by &&
        Math.max(candidate.lower, shift.lower) < Math.min(candidate.from, shift.from) &&
        !candidate.shifts.some((other) => other.track === shift.track),
    );
    if (group === undefined) {
      groups.push({ by: shift.by, from: shift.from, lower: shift.lower, shifts: [shift] });
      continue;
    }
    group.shifts.push(shift);
    group.from = Math.min(group.from, shift.from);
    group.lower = Math.max(group.lower, shift.lower);
  }
  const members = (group: (typeof groups)[number]) =>
    group.shifts.flatMap((shift) => shift.kept.slice(shift.at));
  const lasting = groups.filter((group) => {
    const [only, ...rest] = members(group);
    if (only !== undefined && rest.length === 0) moved.add(only);
    return rest.length > 0;
  });
  const ripples = lasting.map((group): Ripple => {
    const tracks = group.shifts.map((shift) => shift.track);
    return {
      from: group.from,
      by: group.by,
      tracks,
      held: base.tracks
        .map((track) => track.name)
        .filter(
          (name) =>
            !tracks.includes(name) &&
            (keptOn.get(name) ?? []).some((pair) => !moved.has(pair) && pair.from >= group.from),
        ),
      pairs: members(group).filter((pair) => !moved.has(pair)),
    };
  });

  const matchedBase = new Set(matched.map(([from]) => from));
  const matchedNext = new Set(matched.map(([, to]) => to));
  const nextNames = new Set(trackNames.values());
  const trackChanges = base.tracks.flatMap((track) => {
    const other = next.tracks.find((candidate) => candidate.name === trackNames.get(track.name));
    if (other === undefined) return [];
    const properties = changedProperties(track.source, other.source);
    return properties.length > 0 ? [{ base: track, next: other, properties }] : [];
  });
  return {
    rate: next.rate,
    base,
    next,
    pairs,
    byBaseId: new Map(pairs.map((pair) => [pair.base.id, pair])),
    removed: base.clips.filter((item) => !matchedBase.has(item)),
    added: next.clips.filter((item) => !matchedNext.has(item)),
    moved,
    ripples,
    trackNames,
    renames: [...trackNames].filter(([from, to]) => from !== to),
    tracksAdded: next.tracks.filter((track) => !nextNames.has(track.name)),
    tracksRemoved: base.tracks.filter((track) => !trackNames.has(track.name)),
    trackChanges,
  };
};

const stateOf = (item: Placed): ClipState => ({
  id: item.id,
  name: item.clip.name,
  track: item.track,
  startFrame: item.start,
  endFrame: item.end,
});

const trimmedChange = (pair: Pair, edges: { start: boolean; end: boolean }): TimelineChange => ({
  kind: "trimmed",
  before: stateOf(pair.base),
  after: stateOf(pair.next),
  ...(edges.start && pair.trimStart !== 0
    ? { start: { before: pair.base.start, after: pair.base.start + pair.trimStart } }
    : {}),
  ...(edges.end && pair.trimEnd !== 0
    ? { end: { before: pair.base.end, after: pair.base.end + pair.trimEnd } }
    : {}),
});

const changedChange = (pair: Pair, properties: ReadonlyArray<string>): TimelineChange => ({
  kind: "changed",
  before: stateOf(pair.base),
  after: stateOf(pair.next),
  properties,
});

const movedChange = (pair: Pair): TimelineChange => ({
  kind: "moved",
  before: stateOf(pair.base),
  after: stateOf(pair.next),
});

const rippledChange = (ripple: Ripple, analysis: Analysis): TimelineChange => {
  const named = (tracks: ReadonlyArray<string>) =>
    analysis.next.tracks
      .map((track) => track.name)
      .filter((name) => tracks.some((track) => analysis.trackNames.get(track) === name));
  return {
    kind: "rippled",
    tracks: named(ripple.tracks),
    heldTracks: named(ripple.held),
    fromFrame: ripple.from,
    byFrames: ripple.by,
    clipIds: ripple.pairs.map((pair) => pair.next.id),
  };
};

const changesOf = (analysis: Analysis): Array<TimelineChange> => {
  const trackChanges: Array<TimelineChange> = [
    ...analysis.renames.map(([before, after]): TimelineChange => ({
      kind: "trackRenamed",
      before,
      after,
    })),
    ...analysis.tracksAdded.map((track): TimelineChange => ({
      kind: "trackAdded",
      track: track.name,
      trackKind: track.kind,
    })),
    ...analysis.tracksRemoved.map((track): TimelineChange => ({
      kind: "trackRemoved",
      track: track.name,
      trackKind: track.kind,
    })),
    ...analysis.trackChanges.map((change): TimelineChange => ({
      kind: "trackChanged",
      track: change.next.name,
      properties: change.properties,
    })),
  ];
  const timed: Array<readonly [number, TimelineChange]> = [];
  for (const item of analysis.removed) {
    timed.push([item.start, { kind: "removed", before: stateOf(item) }]);
  }
  for (const pair of analysis.pairs) {
    if (pair.trimStart !== 0 || pair.trimEnd !== 0) {
      timed.push([pair.base.start, trimmedChange(pair, { start: true, end: true })]);
    }
    if (analysis.moved.has(pair)) timed.push([pair.base.start, movedChange(pair)]);
    if (pair.properties.length > 0) {
      timed.push([pair.base.start, changedChange(pair, pair.properties)]);
    }
  }
  for (const ripple of analysis.ripples) timed.push([ripple.from, rippledChange(ripple, analysis)]);
  for (const item of analysis.added) {
    timed.push([item.start, { kind: "added", after: stateOf(item) }]);
  }
  return [...trackChanges, ...timed.toSorted((a, b) => a[0] - b[0]).map(([, change]) => change)];
};

/**
 * What changed from `base` to `next`, two versions of the same timeline, at clip level. Clips
 * are matched by id where one is really carried and by media and source overlap otherwise, so
 * a fresh pull from Premiere diffs cleanly against an edited copy. Many clips shifting together
 * are one `rippled` change. Gaps and timeline-level metadata are not compared.
 */
export const diffTimelines = (base: Timeline, next: Timeline): TimelineDiff => {
  const analysis = analyze(base, next);
  return { rate: analysis.rate, changes: changesOf(analysis) };
};

const span = (state: ClipState) => `${state.track} ${state.startFrame}-${state.endFrame}`;
const signed = (frames: number) => (frames > 0 ? `+${frames}` : String(frames));

/** One change as a line for agents, in the vocabulary of `editableView`. */
export const changeLine = (change: TimelineChange): string => {
  switch (change.kind) {
    case "added":
      return `added ${span(change.after)} #${change.after.id} ${change.after.name}`;
    case "removed":
      return `removed ${span(change.before)} #${change.before.id} ${change.before.name}`;
    case "moved":
      return `moved ${span(change.before)} → ${span(change.after)} #${change.after.id} ${change.after.name}`;
    case "trimmed":
      return [
        `trimmed ${change.after.track} #${change.after.id}`,
        ...(change.start ? [`start ${change.start.before}→${change.start.after}`] : []),
        ...(change.end ? [`end ${change.end.before}→${change.end.after}`] : []),
        change.after.name,
      ].join(" ");
    case "changed":
      return `changed ${span(change.after)} #${change.after.id} ${change.after.name}: ${change.properties.join(", ")}`;
    case "rippled":
      return `rippled ${change.tracks.join(",")} from ${change.fromFrame} by ${signed(change.byFrames)} (${change.clipIds.length} clips)`;
    case "trackAdded":
      return `track added ${change.track}`;
    case "trackRemoved":
      return `track removed ${change.track}`;
    case "trackRenamed":
      return `track renamed ${change.before} → ${change.after}`;
    case "trackChanged":
      return `track changed ${change.track}: ${change.properties.join(", ")}`;
  }
};

/** The diff as text, one line per change; empty when nothing changed. */
export const diffText = (diff: TimelineDiff): string => diff.changes.map(changeLine).join("\n");

const clock = (frame: number, rate: number) => {
  const seconds = Math.floor(frame / rate);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const length = (frames: number, rate: number) => `${(Math.abs(frames) / rate).toFixed(1)}s`;
const list = (words: ReadonlyArray<string>) =>
  words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
const place = (state: ClipState, rate: number) =>
  `${state.track} at ${clock(state.startFrame, rate)}`;

/** One change as a sentence for a UI list: plain words, times as m:ss, no ids. */
export const changeSentence = (change: TimelineChange, rate: number): string => {
  switch (change.kind) {
    case "added":
      return `Added ${change.after.name} to ${place(change.after, rate)}`;
    case "removed":
      return `Removed ${change.before.name} from ${place(change.before, rate)}`;
    case "moved":
      return change.before.track === change.after.track
        ? `Moved ${change.after.name} on ${change.after.track} from ${clock(change.before.startFrame, rate)} to ${clock(change.after.startFrame, rate)}`
        : `Moved ${change.after.name} from ${place(change.before, rate)} to ${place(change.after, rate)}`;
    case "trimmed": {
      const edge = (name: string, frames: number) =>
        frames < 0
          ? `added ${length(frames, rate)} to its ${name}`
          : `cut ${length(frames, rate)} off its ${name}`;
      const edits = [
        ...(change.start ? [edge("start", change.start.after - change.start.before)] : []),
        ...(change.end ? [edge("end", change.end.before - change.end.after)] : []),
      ];
      return `Trimmed ${change.before.name} on ${place(change.before, rate)}: ${list(edits)}`;
    }
    case "changed":
      return `Changed ${list(change.properties)} of ${change.after.name} on ${place(change.after, rate)}`;
    case "rippled":
      return `Moved ${change.clipIds.length} clips on ${list(change.tracks)} ${length(change.byFrames, rate)} ${change.byFrames < 0 ? "earlier" : "later"}, from ${clock(change.fromFrame, rate)} on`;
    case "trackAdded":
      return `Added track ${change.track}`;
    case "trackRemoved":
      return `Removed track ${change.track}`;
    case "trackRenamed":
      return `Renamed track ${change.before} to ${change.after}`;
    case "trackChanged":
      return `Changed ${list(change.properties)} of track ${change.track}`;
  }
};

/** A sentence per change, in the order of `diff.changes`. */
export const diffSentences = (diff: TimelineDiff): Array<string> =>
  diff.changes.map((change) => changeSentence(change, diff.rate));

/**
 * What is wrong with a timeline, in plain words; empty when it is sound. A track's items play
 * back to back, so order and overlap show as a clip whose recorded place (`metadata.premiere
 * .record`, which the Premiere export and the compact view read) disagrees with where it plays.
 * Source ranges are checked against `media` (seconds by `target_url`) where a file is listed.
 */
export const checkTimeline = (
  timeline: Timeline,
  media?: Readonly<Record<string, { readonly duration: number }>>,
): Array<TimelineViolation> => {
  const rate = timeline.global_start_time.rate;
  const violations: Array<TimelineViolation> = [];
  timeline.tracks.children.forEach((track, trackIndex) => {
    let cursor = 0;
    let previous: { start: number; end: number } | undefined;
    track.children.forEach((child, childIndex) => {
      const { start_time, duration } = child.source_range;
      const frames = (duration.value / duration.rate) * rate;
      const isClip = child.OTIO_SCHEMA === "Clip.2";
      const clipId = isClip ? clipIdOf(child, `${trackIndex}:${childIndex}`) : null;
      const label = `${track.name} ${isClip ? child.name : "gap"} at frame ${Math.round(cursor)}`;
      const report = (kind: TimelineViolation["kind"], problem: string) => {
        violations.push({ kind, track: track.name, clipId, message: `${label} ${problem}.` });
      };
      if (frames < 0 || (isClip && frames === 0)) {
        report("duration", frames < 0 ? "has a negative length" : "has no length");
      }
      if (isClip) {
        const recorded = (child.metadata["premiere"] as { record?: unknown } | undefined)?.record;
        const record = isRecord(recorded) ? recorded : {};
        const start = typeof record["startFrame"] === "number" ? record["startFrame"] : cursor;
        const end = typeof record["endFrame"] === "number" ? record["endFrame"] : cursor + frames;
        if (previous !== undefined && start < previous.start) {
          report("order", `is out of time order: it belongs at frame ${Math.round(start)}`);
        } else if (previous !== undefined && start < previous.end - 0.5) {
          report("overlap", "overlaps the previous item");
        } else if (Math.abs(start - cursor) > 0.5 || Math.abs(end - (cursor + frames)) > 0.5) {
          report(
            "position",
            `is recorded at frames ${Math.round(start)}-${Math.round(end)} but plays at ${Math.round(cursor)}-${Math.round(cursor + frames)}`,
          );
        }
        previous = { start, end };
        if (!isStill(child)) {
          const sourceEnd = (start_time.value + duration.value) / start_time.rate;
          const known = media?.[targetOf(child)]?.duration;
          if (start_time.value < 0) report("source", "starts before its media's first frame");
          else if (known !== undefined && sourceEnd > known + 1 / rate) {
            report("source", `runs ${(sourceEnd - known).toFixed(2)}s past the end of its media`);
          }
        }
      }
      cursor += Math.max(0, frames);
    });
  });
  return violations;
};

const mapTracks = (
  timeline: Timeline,
  change: (track: Track, index: number) => Track,
): Timeline => ({
  ...timeline,
  tracks: { ...timeline.tracks, children: timeline.tracks.children.map(change) },
});

const mapClip = (timeline: Timeline, id: string, change: (clip: Clip) => Clip): Timeline =>
  mapTracks(timeline, (track, trackIndex) => ({
    ...track,
    children: track.children.map((child, childIndex) =>
      child.OTIO_SCHEMA === "Clip.2" && clipIdOf(child, `${trackIndex}:${childIndex}`) === id
        ? change(child)
        : child,
    ),
  }));

const withId = (clip: Clip, id: string) =>
  setIn(clip, ["metadata", TIMELINE_NAMESPACE, "id"], id) as Clip;

/** Gives clips known only by position an id of their own, so later steps can't renumber them. */
const withIds = (timeline: Timeline): Timeline =>
  mapTracks(timeline, (track, trackIndex) => ({
    ...track,
    children: track.children.map((child, childIndex) =>
      child.OTIO_SCHEMA === "Clip.2" && clipIdOf(child, "") === ""
        ? withId(child, `${trackIndex}:${childIndex}`)
        : child,
    ),
  }));

/** Total shift of a clip at `frame` (base frames) on a base track, or on a track new since. */
const shiftAt = (ripples: ReadonlyArray<Ripple>, frame: number, track: string | undefined) =>
  ripples.reduce(
    (total, ripple) =>
      ripple.from <= frame && !(track !== undefined && ripple.held.includes(track))
        ? total + ripple.by
        : total,
    0,
  );

/**
 * Three-way merge at clip level: `base` is the last version both sides held, `ours` the copy
 * edited here, `theirs` Premiere's new save. Returns `theirs` with our changes re-applied
 * through `applyEdits`; see `TimelineMerge` for the rules.
 */
export const mergeTimelines = (base: Timeline, ours: Timeline, theirs: Timeline): TimelineMerge => {
  const mine = analyze(base, ours);
  const wanted = changesOf(mine);
  if (wanted.length === 0) return { timeline: theirs, conflicts: [] };
  const their = analyze(base, theirs);
  const rate = their.rate;
  if (mine.rate !== rate || mine.base.rate !== rate) {
    const message = "The frame rate changed, so the edits made here could not be re-applied.";
    return { timeline: theirs, conflicts: wanted.map((change) => ({ message, change })) };
  }

  const conflicts: Array<MergeConflict> = [];
  const conflict = (change: TimelineChange, message: string) => {
    conflicts.push({ message, change });
  };
  const at = (item: Placed) => `${item.clip.name} on ${item.track} at ${clock(item.start, rate)}`;

  let working = withIds(theirs);
  let violations = checkTimeline(working).length;
  const now = () => flatten(working);
  const clipsNow = () => new Map(now().clips.map((item) => [item.id, item]));
  /** Keeps `candidate` if it holds what the step meant and breaks no invariant. */
  const commit = (candidate: Timeline, holds: (clips: ReadonlyMap<string, Placed>) => boolean) => {
    const found = checkTimeline(candidate).length;
    const clips = new Map(flatten(candidate).clips.map((item) => [item.id, item]));
    if (found > violations || !holds(clips)) return false;
    working = candidate;
    violations = found;
    return true;
  };
  const edit = (
    edits: ReadonlyArray<TimelineEdit>,
    holds: (clips: ReadonlyMap<string, Placed>) => boolean,
  ) => commit(applyEdits(working, edits), holds);
  const isClear = (track: string, start: number, end: number, except?: string) =>
    !now().clips.some(
      (item) => item.track === track && item.id !== except && item.start < end && item.end > start,
    );

  // Base track name to its name in the working timeline, and our track names back to base.
  const trackOf = new Map(their.trackNames);
  const baseTrackOf = new Map([...mine.trackNames].map(([from, to]) => [to, from]));
  const hasTrack = (name: string) => working.tracks.children.some((track) => track.name === name);

  for (const [before, after] of mine.renames) {
    const current = trackOf.get(before);
    if (current === after) continue;
    if (current !== before || hasTrack(after)) {
      conflict(
        { kind: "trackRenamed", before, after },
        `Track ${before} was renamed or removed in Premiere, so it was not renamed to ${after}.`,
      );
      continue;
    }
    working = mapTracks(working, (track) =>
      track.name === current ? { ...track, name: after } : track,
    );
    trackOf.set(before, after);
  }

  const newTracks = new Set<string>();
  mine.tracksAdded.forEach((track) => {
    const existing = working.tracks.children.find((other) => other.name === track.name);
    if (existing !== undefined) {
      if (existing.kind === track.kind) newTracks.add(track.name);
      return;
    }
    const below = mine.next.tracks
      .slice(0, mine.next.tracks.indexOf(track))
      .map((other) => {
        const from = baseTrackOf.get(other.name);
        return from === undefined ? other.name : trackOf.get(from);
      })
      .findLast((name) => name !== undefined && hasTrack(name));
    const children = [...working.tracks.children];
    const index = children.findIndex((other) => other.name === below) + 1;
    children.splice(index, 0, { ...track.source, children: [] });
    working = { ...working, tracks: { ...working.tracks, children } };
    newTracks.add(track.name);
  });
  /** The working track that one of our tracks became; undefined when Premiere removed it. */
  const workingTrack = (ourName: string) => {
    const from = baseTrackOf.get(ourName);
    if (from !== undefined) return trackOf.get(from);
    return newTracks.has(ourName) ? ourName : undefined;
  };

  for (const change of mine.trackChanges) {
    const name = trackOf.get(change.base.name);
    const theirChange = their.trackChanges.find((other) => other.base === change.base);
    const ourProperties = propertiesOf(change.next.source);
    const clashing = change.properties.filter(
      (property) =>
        name === undefined ||
        (theirChange?.properties.includes(property) === true &&
          !same(
            ourProperties.get(property)?.value,
            propertiesOf(theirChange.next.source).get(property)?.value,
          )),
    );
    if (clashing.length > 0) {
      conflict(
        { kind: "trackChanged", track: change.next.name, properties: clashing },
        `Track ${change.base.name} was changed in Premiere too (${list(clashing)}); Premiere's version was kept.`,
      );
    }
    const applying = change.properties.filter((property) => !clashing.includes(property));
    working = mapTracks(working, (track) =>
      track.name === name ? carry(track, change.next.source, change.base.source, applying) : track,
    );
  }

  // Property changes, then deletes, then trims: none of them moves another clip.
  for (const pair of mine.pairs) {
    if (pair.properties.length === 0) continue;
    const theirPair = their.byBaseId.get(pair.base.id);
    if (theirPair === undefined) {
      conflict(
        changedChange(pair, pair.properties),
        `${at(pair.base)} was deleted in Premiere, so the change to its ${list(pair.properties)} was dropped.`,
      );
      continue;
    }
    const ourProperties = propertiesOf(pair.next.clip);
    const theirProperties = propertiesOf(theirPair.next.clip);
    const clashing = pair.properties.filter(
      (property) =>
        theirPair.properties.includes(property) &&
        !same(ourProperties.get(property)?.value, theirProperties.get(property)?.value),
    );
    if (clashing.length > 0) {
      conflict(
        changedChange(pair, clashing),
        `${at(pair.base)} had its ${list(clashing)} changed on both sides; Premiere's version was kept.`,
      );
    }
    const applying = pair.properties.filter((property) => !theirPair.properties.includes(property));
    working = mapClip(working, theirPair.next.id, (clip) =>
      carry(clip, pair.next.clip, pair.base.clip, applying),
    );
  }

  for (const item of mine.removed) {
    const theirPair = their.byBaseId.get(item.id);
    if (theirPair === undefined) continue;
    const id = theirPair.next.id;
    const touched =
      theirPair.trimStart !== 0 ||
      theirPair.trimEnd !== 0 ||
      theirPair.properties.length > 0 ||
      their.moved.has(theirPair);
    if (touched || !edit([{ kind: "delete", clipId: id }], (clips) => !clips.has(id))) {
      conflict(
        { kind: "removed", before: stateOf(item) },
        `${at(item)} was changed in Premiere, so it was not removed.`,
      );
    }
  }

  for (const pair of mine.pairs) {
    const theirPair = their.byBaseId.get(pair.base.id);
    for (const edge of ["start", "end"] as const) {
      const ourTrim = edge === "start" ? pair.trimStart : pair.trimEnd;
      if (ourTrim === 0) continue;
      const change = trimmedChange(pair, { start: edge === "start", end: edge === "end" });
      if (theirPair === undefined) {
        conflict(change, `${at(pair.base)} was deleted in Premiere, so its trim was dropped.`);
        continue;
      }
      const theirTrim = edge === "start" ? theirPair.trimStart : theirPair.trimEnd;
      if (theirTrim === ourTrim) continue;
      if (theirTrim !== 0) {
        conflict(
          change,
          `${at(pair.base)} had its ${edge} trimmed on both sides; Premiere's trim was kept.`,
        );
        continue;
      }
      const id = theirPair.next.id;
      const current = clipsNow().get(id);
      const frame = (current?.[edge] ?? 0) + ourTrim;
      const trimmed =
        current !== undefined &&
        edit(
          [{ kind: "trim", clipId: id, edge, frame }],
          (clips) => clips.get(id)?.[edge] === frame,
        );
      if (!trimmed) {
        conflict(
          change,
          `${at(pair.base)} has no room in Premiere's version for the trim of its ${edge} made here.`,
        );
      }
    }
  }

  // Ascending, so each ripple's point already carries the ones applied before it.
  const applied: Array<Ripple> = [];
  for (const ripple of mine.ripples) {
    if (their.ripples.some((other) => other.from === ripple.from && other.by === ripple.by)) {
      continue;
    }
    const baseNames = new Map([...trackOf].map(([from, to]) => [to, from]));
    const targets = now().tracks.flatMap((track) => {
      const baseName = baseNames.get(track.name);
      if (baseName !== undefined && ripple.held.includes(baseName)) return [];
      const threshold =
        ripple.from +
        shiftAt(their.ripples, ripple.from, baseName) +
        shiftAt(applied, ripple.from, baseName);
      return [{ track, threshold, clips: track.clips.filter((item) => item.start >= threshold) }];
    });
    // Closing a gap needs the gap: a clip Premiere has there would be cut or slid under.
    const blocked =
      ripple.by < 0 &&
      targets.some(
        ({ track, threshold, clips }) =>
          (clips.length > 0 && threshold + ripple.by < 0) ||
          track.clips.some((item) => item.start < threshold && item.end > threshold + ripple.by),
      );
    const [first] = targets;
    const everywhere =
      first !== undefined &&
      targets.length === working.tracks.children.length &&
      targets.every((target) => target.threshold === first.threshold);
    const edits: Array<TimelineEdit> =
      ripple.by < 0 && everywhere
        ? [
            {
              kind: "removeRange",
              start: first.threshold + ripple.by,
              end: first.threshold,
              ripple: true,
            },
          ]
        : targets.flatMap(({ track, clips }) =>
            // Nearest the freed space first, so no clip lands on one still waiting to move.
            clips
              .toSorted((a, b) => (ripple.by < 0 ? a.start - b.start : b.start - a.start))
              .map((item) => ({
                kind: "move" as const,
                clipId: item.id,
                toTrack: track.name,
                startFrame: item.start + ripple.by,
              })),
          );
    const shifted =
      !blocked &&
      edit(edits, (clips) =>
        targets.every((target) =>
          target.clips.every((item) => clips.get(item.id)?.start === item.start + ripple.by),
        ),
      );
    if (shifted) applied.push(ripple);
    else {
      conflict(
        rippledChange(ripple, mine),
        `Premiere's version has clips in the way, so the clips from ${clock(ripple.from, rate)} on were not moved ${length(ripple.by, rate)} ${ripple.by < 0 ? "earlier" : "later"}.`,
      );
    }
  }

  /** A frame of ours in the merged timeline: back through our ripples, forward through all applied. */
  const merged = (frame: number, ourTrack: string) => {
    const baseName = baseTrackOf.get(ourTrack);
    let undone = 0;
    for (const ripple of mine.ripples) {
      if (baseName !== undefined && ripple.held.includes(baseName)) continue;
      if (frame - undone - ripple.by >= ripple.from) undone += ripple.by;
    }
    const inBase = frame - undone;
    return inBase + shiftAt(their.ripples, inBase, baseName) + shiftAt(applied, inBase, baseName);
  };

  for (const pair of mine.pairs) {
    if (!mine.moved.has(pair)) continue;
    const change = movedChange(pair);
    const theirPair = their.byBaseId.get(pair.base.id);
    const current = theirPair === undefined ? undefined : clipsNow().get(theirPair.next.id);
    const toTrack = workingTrack(pair.next.track);
    if (theirPair === undefined || current === undefined) {
      conflict(change, `${at(pair.base)} was deleted in Premiere, so its move was dropped.`);
      continue;
    }
    const startFrame = merged(pair.next.start, pair.next.track);
    if (current.track === toTrack && current.start === startFrame) continue;
    if (their.moved.has(theirPair)) {
      conflict(change, `${at(pair.base)} was moved on both sides; Premiere's place was kept.`);
      continue;
    }
    const id = current.id;
    const fits =
      toTrack !== undefined &&
      isClear(toTrack, startFrame, startFrame + (current.end - current.start), id) &&
      edit([{ kind: "move", clipId: id, toTrack, startFrame }], (clips) => {
        const landed = clips.get(id);
        return landed?.track === toTrack && landed.start === startFrame;
      });
    if (!fits) {
      conflict(
        change,
        `${at(pair.base)} could not be moved to ${pair.next.track} at ${clock(pair.next.start, rate)}: Premiere's version has no room there.`,
      );
    }
  }

  const baseIds = new Set(mine.base.clips.map((item) => item.id));
  for (const item of mine.added) {
    const change: TimelineChange = { kind: "added", after: stateOf(item) };
    const toTrack = workingTrack(item.track);
    const startFrame = merged(item.start, item.track);
    const endFrame = startFrame + (item.end - item.start);
    const clips = clipsNow();
    const alreadyThere = [...clips.values()].some(
      (other) =>
        other.track === toTrack &&
        other.start === startFrame &&
        other.end === endFrame &&
        targetOf(other.clip) === targetOf(item.clip) &&
        same(other.clip.source_range, item.clip.source_range),
    );
    if (alreadyThere) continue;
    // A piece cut from a clip (`id~frame`) is cut from their copy of it, keeping their effects.
    let parentId = item.id;
    while (parentId.includes("~") && !baseIds.has(parentId)) {
      parentId = parentId.slice(0, parentId.lastIndexOf("~"));
    }
    const parent = parentId === item.id ? undefined : mine.byBaseId.get(parentId)?.base;
    const theirParent = their.byBaseId.get(parentId);
    if (parent !== undefined && theirParent === undefined) {
      conflict(
        change,
        `${at(item)} is cut from a clip that was deleted in Premiere, so it was not added.`,
      );
      continue;
    }
    let id = item.id;
    while (clips.has(id)) id = `${id}+`;
    const content = withId(
      parent === undefined || theirParent === undefined
        ? item.clip
        : carry(
            { ...theirParent.next.clip, source_range: item.clip.source_range },
            item.clip,
            parent.clip,
            changedProperties(parent.clip, item.clip).filter(
              (property) => !theirParent.properties.includes(property),
            ),
          ),
      id,
    );
    // No edit adds a clip, so it joins the end of its track and is moved into place like a drag.
    const fits =
      toTrack !== undefined &&
      isClear(toTrack, startFrame, endFrame) &&
      commit(
        applyEdits(
          mapTracks(working, (track) =>
            track.name === toTrack ? { ...track, children: [...track.children, content] } : track,
          ),
          [{ kind: "move", clipId: id, toTrack, startFrame }],
        ),
        (after) => {
          const landed = after.get(id);
          return landed?.track === toTrack && landed.start === startFrame;
        },
      );
    if (!fits) {
      conflict(change, `${at(item)} could not be added: Premiere's version has no room there.`);
    }
  }

  for (const track of mine.tracksRemoved) {
    const name = trackOf.get(track.name);
    const current = now().tracks.find((other) => other.name === name);
    if (current === undefined) continue;
    if (current.clips.length > 0) {
      conflict(
        { kind: "trackRemoved", track: track.name, trackKind: track.kind },
        `Track ${track.name} still has clips in Premiere's version, so it was kept.`,
      );
      continue;
    }
    working = {
      ...working,
      tracks: {
        ...working.tracks,
        children: working.tracks.children.filter((other) => other.name !== name),
      },
    };
  }

  return { timeline: working, conflicts };
};
