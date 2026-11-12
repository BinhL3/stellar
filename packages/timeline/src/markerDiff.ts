/**
 * What changed among a timeline's markers between two versions, and the marker half of the
 * three-way merge. A clip's marker is compared by where it sits in the clip's media, so moving
 * or rippling the clip is not a change to the marker.
 */
import { layoutTimeline } from "./layout.ts";
import { clipMarkerSpan, markerIdOf } from "./markers.ts";
import { type Clip, type Marker, type Timeline, TIMELINE_NAMESPACE, timeRange } from "./otio.ts";

/** A marker in one version of the timeline. */
export interface MarkerState {
  readonly id: string;
  readonly name: string;
  readonly frame: number;
  readonly durationFrames: number;
  /** The clip it is pinned to; null for a sequence marker. */
  readonly clipId: string | null;
  readonly resolved: boolean;
}

export type MarkerProperty = "position" | "length" | "name" | "note" | "colour" | "resolved";

export type MarkerChange =
  | { readonly kind: "markerAdded"; readonly after: MarkerState }
  | { readonly kind: "markerRemoved"; readonly before: MarkerState }
  | {
      readonly kind: "markerChanged";
      readonly before: MarkerState;
      readonly after: MarkerState;
      readonly properties: ReadonlyArray<MarkerProperty>;
    };

/** A marker with what it is compared by. */
export interface MarkerEntry {
  readonly state: MarkerState;
  readonly marker: Marker;
  readonly media: string | null;
  readonly values: Readonly<Record<MarkerProperty, string | number | boolean>>;
}

const milliseconds = (value: number, rate: number) => Math.round((value / rate) * 1000);

/** Every marker once, by id: sequence markers, then clip markers whether or not they show. */
const markerEntries = (timeline: Timeline): Array<MarkerEntry> => {
  const rate = timeline.global_start_time.rate;
  const out: Array<MarkerEntry> = [];
  const seen = new Set<string>();
  const add = (
    marker: Marker,
    id: string,
    frame: number,
    durationFrames: number,
    clipId: string | null,
    media: string | null,
  ) => {
    if (seen.has(id)) return;
    seen.add(id);
    const { start_time, duration } = marker.marked_range;
    const meta = marker.metadata[TIMELINE_NAMESPACE] as { resolved?: boolean } | undefined;
    const resolved = meta?.resolved === true;
    out.push({
      state: { id, name: marker.name, frame, durationFrames, clipId, resolved },
      marker,
      media,
      values: {
        position: clipId === null ? frame : milliseconds(start_time.value, start_time.rate),
        length: clipId === null ? durationFrames : milliseconds(duration.value, duration.rate),
        name: marker.name,
        note: marker.comment,
        colour: marker.color,
        resolved,
      },
    });
  };
  (timeline.tracks.markers ?? []).forEach((marker, index) => {
    const { start_time, duration } = marker.marked_range;
    add(
      marker,
      markerIdOf(marker, `s${index}`),
      Math.round((start_time.value / start_time.rate) * rate),
      Math.round((duration.value / duration.rate) * rate),
      null,
      null,
    );
  });
  const hasClipMarkers = timeline.tracks.children.some((track) =>
    track.children.some((child) => child.OTIO_SCHEMA === "Clip.2" && child.markers !== undefined),
  );
  if (!hasClipMarkers) return out;
  for (const track of layoutTimeline(timeline).tracks) {
    for (const laid of track.clips) {
      const item = {
        id: laid.key,
        start: Math.round(laid.startFrame),
        end: Math.round(laid.endFrame),
        clip: laid.clip,
      };
      (laid.clip.markers ?? []).forEach((marker, index) => {
        const span = clipMarkerSpan(item, marker, rate);
        add(
          marker,
          markerIdOf(marker, `${item.id}.${index}`),
          span.frame,
          span.durationFrames,
          item.id,
          laid.clip.media_references.DEFAULT_MEDIA.target_url,
        );
      });
    }
  }
  return out;
};

const PROPERTIES: ReadonlyArray<MarkerProperty> = [
  "position",
  "length",
  "name",
  "note",
  "colour",
  "resolved",
];

/** A marker made here comes back from Premiere under Premiere's id: same place, same words. */
const alike = (a: MarkerEntry, b: MarkerEntry) =>
  (a.state.clipId === null) === (b.state.clipId === null) &&
  a.media === b.media &&
  a.values.position === b.values.position &&
  a.values.name === b.values.name &&
  a.values.note === b.values.note;

interface Pairing {
  readonly pairs: ReadonlyArray<readonly [MarkerEntry, MarkerEntry]>;
  readonly removed: ReadonlyArray<MarkerEntry>;
  readonly added: ReadonlyArray<MarkerEntry>;
}

const pair = (base: ReadonlyArray<MarkerEntry>, next: ReadonlyArray<MarkerEntry>): Pairing => {
  const byId = new Map(next.map((entry) => [entry.state.id, entry]));
  const pairs: Array<readonly [MarkerEntry, MarkerEntry]> = [];
  const taken = new Set<MarkerEntry>();
  const loose: Array<MarkerEntry> = [];
  for (const entry of base) {
    const other = byId.get(entry.state.id);
    if (other === undefined) loose.push(entry);
    else {
      pairs.push([entry, other]);
      taken.add(other);
    }
  }
  const removed: Array<MarkerEntry> = [];
  for (const entry of loose) {
    const other = next.find((candidate) => !taken.has(candidate) && alike(entry, candidate));
    if (other === undefined) removed.push(entry);
    else {
      pairs.push([entry, other]);
      taken.add(other);
    }
  }
  return { pairs, removed, added: next.filter((entry) => !taken.has(entry)) };
};

const changedProperties = (before: MarkerEntry, after: MarkerEntry) =>
  PROPERTIES.filter((property) => before.values[property] !== after.values[property]);

/** Markers paired across two versions, for a plan that needs each marker's own values. */
export const markerPairs = (base: Timeline, next: Timeline) => {
  const { pairs, removed, added } = pair(markerEntries(base), markerEntries(next));
  return {
    removed,
    added,
    changed: pairs.flatMap(([before, after]) => {
      const properties = changedProperties(before, after);
      return properties.length === 0 ? [] : [{ before, after, properties }];
    }),
  };
};

/** Marker changes from `base` to `next`, in timeline order. */
export const markerChanges = (base: Timeline, next: Timeline): Array<MarkerChange> => {
  if (!hasMarkers(base) && !hasMarkers(next)) return [];
  const { pairs, removed, added } = pair(markerEntries(base), markerEntries(next));
  const timed: Array<readonly [number, MarkerChange]> = [
    ...removed.map(
      (entry) => [entry.state.frame, { kind: "markerRemoved", before: entry.state }] as const,
    ),
    ...pairs.flatMap(([before, after]) => {
      const properties = changedProperties(before, after);
      return properties.length === 0
        ? []
        : [
            [
              before.state.frame,
              { kind: "markerChanged", before: before.state, after: after.state, properties },
            ] as const,
          ];
    }),
    ...added.map(
      (entry) => [entry.state.frame, { kind: "markerAdded", after: entry.state }] as const,
    ),
  ];
  return timed.toSorted((a, b) => a[0] - b[0]).map(([, change]) => change);
};

const hasMarkers = (timeline: Timeline) =>
  timeline.tracks.markers !== undefined ||
  timeline.tracks.children.some((track) =>
    track.children.some((child) => child.OTIO_SCHEMA === "Clip.2" && child.markers !== undefined),
  );

const span = (state: MarkerState) =>
  state.durationFrames > 0
    ? `${state.frame}-${state.frame + state.durationFrames}`
    : String(state.frame);
const label = (state: MarkerState) => JSON.stringify(state.name || "(unnamed)");
const pinned = (state: MarkerState) => (state.clipId === null ? "" : ` on #${state.clipId}`);

/** One marker change as a line for agents, in the vocabulary of `markersText`. */
export const markerChangeLine = (change: MarkerChange): string => {
  switch (change.kind) {
    case "markerAdded":
      return `added marker ${span(change.after)} #${change.after.id}${pinned(change.after)} ${label(change.after)}`;
    case "markerRemoved":
      return `removed marker ${span(change.before)} #${change.before.id}${pinned(change.before)} ${label(change.before)}`;
    case "markerChanged":
      return `changed marker ${span(change.after)} #${change.after.id}${pinned(change.after)} ${label(change.after)}: ${change.properties.join(", ")}`;
  }
};

const clock = (frame: number, rate: number) => {
  const seconds = Math.floor(Math.max(0, frame) / rate);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const words = (items: ReadonlyArray<string>) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const named = (state: MarkerState) => (state.name === "" ? "a marker" : `marker “${state.name}”`);

/** One marker change as a sentence for a UI list. */
export const markerChangeSentence = (change: MarkerChange, rate: number): string => {
  switch (change.kind) {
    case "markerAdded":
      return `Added ${named(change.after)} at ${clock(change.after.frame, rate)}`;
    case "markerRemoved":
      return `Removed ${named(change.before)} from ${clock(change.before.frame, rate)}`;
    case "markerChanged": {
      const { properties, before, after } = change;
      if (properties.length === 1 && properties[0] === "resolved") {
        return `${after.resolved ? "Resolved" : "Reopened"} ${named(after)} at ${clock(after.frame, rate)}`;
      }
      if (properties.length === 1 && properties[0] === "position") {
        return `Moved ${named(after)} from ${clock(before.frame, rate)} to ${clock(after.frame, rate)}`;
      }
      return `Changed the ${words(properties)} of ${named(after)} at ${clock(after.frame, rate)}`;
    }
  }
};

export interface MarkerMergeConflict {
  readonly message: string;
  readonly change: MarkerChange;
}

const setProperty = (
  marker: Marker,
  property: MarkerProperty,
  from: MarkerEntry,
  frames: { readonly frame: number; readonly rate: number },
): Marker => {
  switch (property) {
    case "name":
      return { ...marker, name: from.marker.name };
    case "note":
      return { ...marker, comment: from.marker.comment };
    case "colour":
      return { ...marker, color: from.marker.color };
    case "resolved": {
      const { resolved: _was, ...meta } =
        (marker.metadata[TIMELINE_NAMESPACE] as Record<string, unknown> | undefined) ?? {};
      return {
        ...marker,
        metadata: {
          ...marker.metadata,
          [TIMELINE_NAMESPACE]: { ...meta, ...(from.values.resolved ? { resolved: true } : {}) },
        },
      };
    }
    case "position":
    case "length": {
      if (from.state.clipId !== null) {
        // Both sides measure a clip's marker in the same media, so ours carries over as it is.
        const ours = from.marker.marked_range;
        return {
          ...marker,
          marked_range:
            property === "position"
              ? { ...marker.marked_range, start_time: ours.start_time }
              : { ...marker.marked_range, duration: ours.duration },
        };
      }
      const { start_time, duration } = marker.marked_range;
      const start =
        property === "position"
          ? frames.frame
          : Math.round((start_time.value / start_time.rate) * frames.rate);
      const length =
        property === "length"
          ? from.state.durationFrames
          : Math.round((duration.value / duration.rate) * frames.rate);
      return { ...marker, marked_range: timeRange(start, length, frames.rate) };
    }
  }
};

/**
 * The marker half of `mergeTimelines`: `working` is Premiere's version with our clip edits
 * already re-applied, and each marker change of ours is put on it unless Premiere changed the
 * same thing. Markers are matched by id, and one made here that Premiere now holds under its
 * own id (same place, same words) is the same marker.
 */
export const mergeMarkers = (input: {
  readonly base: Timeline;
  readonly ours: Timeline;
  readonly theirs: Timeline;
  readonly working: Timeline;
  /** A frame of ours in the merged timeline. */
  readonly mapFrame: (frame: number) => number;
  /** The merged timeline's clip for one of ours; undefined when Premiere deleted it. */
  readonly clipFor: (ourClipId: string) => string | undefined;
  readonly clipIdOf: (clip: Clip, fallback: string) => string;
}): { readonly timeline: Timeline; readonly conflicts: ReadonlyArray<MarkerMergeConflict> } => {
  const { base, ours, theirs } = input;
  if (!hasMarkers(base) && !hasMarkers(ours)) return { timeline: input.working, conflicts: [] };
  const rate = theirs.global_start_time.rate;
  const baseEntries = markerEntries(base);
  const mine = pair(baseEntries, markerEntries(ours));
  const their = pair(baseEntries, markerEntries(theirs));
  const theirOf = new Map(their.pairs.map(([from, to]) => [from, to]));
  const conflicts: Array<MarkerMergeConflict> = [];
  const at = (state: MarkerState) => `${named(state)} at ${clock(state.frame, rate)}`;

  let sequence = [...(input.working.tracks.markers ?? [])];
  const clipChanges = new Map<string, (markers: ReadonlyArray<Marker>) => Array<Marker>>();
  const onClip = (
    clipId: string,
    change: (markers: ReadonlyArray<Marker>) => Array<Marker>,
  ): void => {
    const earlier = clipChanges.get(clipId);
    clipChanges.set(clipId, earlier ? (markers) => change(earlier(markers)) : change);
  };
  /** Replaces a marker of theirs wherever it is carried, by its id. */
  const everywhere = (entry: MarkerEntry, change: (marker: Marker) => Marker | null) => {
    const apply = (markers: ReadonlyArray<Marker>, fallback: (index: number) => string) =>
      markers.flatMap((marker, index) => {
        if (markerIdOf(marker, fallback(index)) !== entry.state.id) return [marker];
        const next = change(marker);
        return next === null ? [] : [next];
      });
    if (entry.state.clipId === null) {
      sequence = apply(sequence, (index) => `s${index}`);
      return;
    }
    input.working.tracks.children.forEach((track, trackIndex) => {
      track.children.forEach((child, childIndex) => {
        if (child.OTIO_SCHEMA !== "Clip.2" || child.markers === undefined) return;
        const clipId = input.clipIdOf(child, `${trackIndex}:${childIndex}`);
        onClip(clipId, (markers) => apply(markers, (index) => `${clipId}.${index}`));
      });
    });
  };

  for (const [before, after] of mine.pairs) {
    const properties = changedProperties(before, after);
    if (properties.length === 0) continue;
    const theirEntry = theirOf.get(before);
    const change = (names: ReadonlyArray<MarkerProperty>): MarkerChange => ({
      kind: "markerChanged",
      before: before.state,
      after: after.state,
      properties: names,
    });
    if (theirEntry === undefined) {
      conflicts.push({
        message: `${at(before.state)} was deleted in Premiere, so the change to its ${words(properties)} was dropped.`,
        change: change(properties),
      });
      continue;
    }
    const theirChanges = changedProperties(before, theirEntry);
    const wanted = (property: MarkerProperty) =>
      property === "position" && after.state.clipId === null
        ? input.mapFrame(after.state.frame)
        : after.values[property];
    const clashing = properties.filter(
      (property) =>
        theirChanges.includes(property) && theirEntry.values[property] !== wanted(property),
    );
    if (clashing.length > 0) {
      conflicts.push({
        message: `${at(before.state)} had its ${words(clashing)} changed on both sides; Premiere's version was kept.`,
        change: change(clashing),
      });
    }
    const applying = properties.filter((property) => !theirChanges.includes(property));
    if (applying.length === 0) continue;
    everywhere(theirEntry, (marker) =>
      applying.reduce(
        (patched, property) =>
          setProperty(patched, property, after, {
            frame: input.mapFrame(after.state.frame),
            rate,
          }),
        marker,
      ),
    );
  }

  for (const entry of mine.removed) {
    const theirEntry = theirOf.get(entry);
    if (theirEntry === undefined) continue;
    if (changedProperties(entry, theirEntry).length > 0) {
      conflicts.push({
        message: `${at(entry.state)} was changed in Premiere, so it was not removed.`,
        change: { kind: "markerRemoved", before: entry.state },
      });
      continue;
    }
    everywhere(theirEntry, () => null);
  }

  const theirNew = their.added;
  for (const entry of mine.added) {
    const frame = entry.state.clipId === null ? input.mapFrame(entry.state.frame) : 0;
    const moved: MarkerEntry =
      entry.state.clipId === null
        ? { ...entry, values: { ...entry.values, position: frame } }
        : entry;
    if (theirNew.some((other) => alike(moved, other))) continue;
    if (entry.state.clipId === null) {
      sequence.push({
        ...entry.marker,
        marked_range: timeRange(frame, entry.state.durationFrames, rate),
      });
      continue;
    }
    const clipId = input.clipFor(entry.state.clipId);
    if (clipId === undefined) {
      conflicts.push({
        message: `${at(entry.state)} is on a clip that was deleted in Premiere, so it was not added.`,
        change: { kind: "markerAdded", after: entry.state },
      });
      continue;
    }
    onClip(clipId, (markers) =>
      markers.some((marker, index) => markerIdOf(marker, `${clipId}.${index}`) === entry.state.id)
        ? [...markers]
        : [...markers, entry.marker],
    );
  }

  const { markers: _before, ...stack } = input.working.tracks;
  return {
    conflicts,
    timeline: {
      ...input.working,
      tracks: {
        ...stack,
        children: stack.children.map((track, trackIndex) => ({
          ...track,
          children: track.children.map((child, childIndex) => {
            if (child.OTIO_SCHEMA !== "Clip.2") return child;
            const change = clipChanges.get(input.clipIdOf(child, `${trackIndex}:${childIndex}`));
            if (change === undefined) return child;
            const markers = change(child.markers ?? []);
            const { markers: _was, ...bare } = child;
            return markers.length === 0 ? bare : { ...child, markers };
          }),
        })),
        ...(sequence.length === 0 ? {} : { markers: sequence }),
      },
    },
  };
};
