/**
 * Markers are OTIO's own `Marker.2`: on the stack for the sequence (timeline frames) or on a
 * clip (its media time), where OTIO's Premiere and Final Cut adapters put them, so any OTIO
 * tool reads ours. Who made one and whether it is resolved live in `metadata.stellar`.
 */
import { layoutTimeline } from "./layout.ts";
import {
  type Clip,
  type Marker,
  type MarkerColor,
  type Timeline,
  TIMELINE_NAMESPACE,
  timeRange,
} from "./otio.ts";
import { offsetAtSourceSeconds, sourceSecondsAt, timeScalarOf } from "./speed.ts";

export type MarkerAuthor = "user" | "agent";

/** Premiere's eight marker colours, in the order of the index it stores. */
export const PREMIERE_MARKER_COLORS: ReadonlyArray<MarkerColor> = [
  "GREEN",
  "RED",
  "PURPLE",
  "ORANGE",
  "YELLOW",
  "WHITE",
  "BLUE",
  "CYAN",
];
export const DEFAULT_MARKER_COLOR: MarkerColor = "GREEN";

/** Marker edits, in whole timeline frames like every other edit. */
export type MarkerEdit =
  | {
      readonly kind: "addMarker";
      readonly frame: number;
      /** Frames the marker spans; none for a point. */
      readonly duration?: number;
      readonly name?: string;
      readonly note?: string;
      readonly color?: MarkerColor;
      readonly author?: MarkerAuthor;
      /** Pins the marker to this clip's picture at `frame`, so it follows the clip. */
      readonly clipId?: string;
      /** The id to give it; omitted, one made from its place and words, such as `m3k9x`. */
      readonly markerId?: string;
    }
  | {
      readonly kind: "setMarker";
      readonly markerId: string;
      readonly frame?: number;
      readonly duration?: number;
      readonly name?: string;
      readonly note?: string;
      readonly color?: MarkerColor;
      readonly resolved?: boolean;
    }
  | { readonly kind: "removeMarker"; readonly markerId: string };

export const isMarkerEdit = (edit: { readonly kind: string }): edit is MarkerEdit =>
  edit.kind === "addMarker" || edit.kind === "setMarker" || edit.kind === "removeMarker";

/** A marker where it shows on the timeline. */
export interface PlacedMarker {
  readonly id: string;
  readonly frame: number;
  readonly durationFrames: number;
  readonly name: string;
  readonly note: string;
  readonly color: MarkerColor;
  readonly author: MarkerAuthor;
  readonly resolved: boolean;
  /** The clip it is pinned to, and that clip's track; null for a sequence marker. */
  readonly clipId: string | null;
  readonly track: string | null;
}

interface MarkerMeta {
  readonly id?: string;
  readonly author?: MarkerAuthor;
  readonly resolved?: boolean;
}

const metaOf = (marker: Marker): MarkerMeta =>
  (marker.metadata[TIMELINE_NAMESPACE] as MarkerMeta | undefined) ?? {};

/** A marker's id: its own, else its place in the list it sits in. */
export const markerIdOf = (marker: Marker, fallback: string): string =>
  metaOf(marker).id ?? fallback;

const sequenceFallback = (index: number) => `s${index}`;
const clipFallback = (clipId: string, index: number) => `${clipId}.${index}`;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

interface ClipPlace {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly clip: Clip;
}

/** Where a clip's marker falls on the timeline; it may be outside the part the clip plays. */
export const clipMarkerSpan = (
  item: ClipPlace,
  marker: Marker,
  rate: number,
): { readonly frame: number; readonly durationFrames: number; readonly visible: boolean } => {
  const { start_time, duration } = marker.marked_range;
  const offset = offsetAtSourceSeconds(item.clip, start_time.value / start_time.rate);
  const frame = Math.round(item.start + offset * rate);
  const scalar = Math.abs(timeScalarOf(item.clip));
  return {
    frame,
    durationFrames: Math.max(0, Math.round((duration.value / duration.rate / scalar) * rate)),
    visible: frame >= item.start && frame < item.end,
  };
};

const placedOf = (
  marker: Marker,
  id: string,
  frame: number,
  durationFrames: number,
  clipId: string | null,
  track: string | null,
): PlacedMarker => {
  const meta = metaOf(marker);
  return {
    id,
    frame,
    durationFrames,
    name: marker.name,
    note: marker.comment,
    color: marker.color,
    author: meta.author === "agent" ? "agent" : "user",
    resolved: meta.resolved === true,
    clipId,
    track,
  };
};

/**
 * Every marker that shows, in timeline order: sequence markers, and clip markers on the part of
 * the media their clip plays. One marker carried by linked picture and sound is listed once.
 */
export const timelineMarkers = (timeline: Timeline): Array<PlacedMarker> => {
  const rate = timeline.global_start_time.rate;
  const out: Array<PlacedMarker> = [];
  (timeline.tracks.markers ?? []).forEach((marker, index) => {
    const { start_time, duration } = marker.marked_range;
    out.push(
      placedOf(
        marker,
        markerIdOf(marker, sequenceFallback(index)),
        Math.round((start_time.value / start_time.rate) * rate),
        Math.round((duration.value / duration.rate) * rate),
        null,
        null,
      ),
    );
  });
  const hasClipMarkers = timeline.tracks.children.some((track) =>
    track.children.some((child) => child.OTIO_SCHEMA === "Clip.2" && child.markers !== undefined),
  );
  if (hasClipMarkers) {
    const seen = new Set<string>();
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
          const id = markerIdOf(marker, clipFallback(item.id, index));
          if (!span.visible || seen.has(`${id}@${span.frame}`)) return;
          seen.add(`${id}@${span.frame}`);
          out.push(placedOf(marker, id, span.frame, span.durationFrames, item.id, track.name));
        });
      }
    }
  }
  return out.toSorted((a, b) => a.frame - b.frame);
};

/**
 * An id for a marker made here, from where it is and what it says. Edits are replayed (undo,
 * merge), so the id can't be random, and a counter would hand a removed marker's id to the next
 * one made, which a diff would then read as the old marker changed.
 */
const newMarkerId = (seed: string, taken: ReadonlyArray<string>): string => {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  }
  const id = `m${(hash >>> 0).toString(36).padStart(4, "0").slice(-4)}`;
  let unique = id;
  for (let copy = 2; taken.includes(unique); copy += 1) unique = `${id}${copy}`;
  return unique;
};

/** What `applyEdits` holds while it runs: the stack's markers and every placed clip. */
export interface MarkerHost {
  sequence: ReadonlyArray<Marker>;
  readonly clips: () => ReadonlyArray<ClipPlace>;
  readonly setClip: (id: string, clip: Clip) => void;
}

const allIds = (host: MarkerHost): Array<string> => [
  ...host.sequence.map((marker, index) => markerIdOf(marker, sequenceFallback(index))),
  ...host
    .clips()
    .flatMap((item) =>
      (item.clip.markers ?? []).map((marker, index) =>
        markerIdOf(marker, clipFallback(item.id, index)),
      ),
    ),
];

/** A timeline span as a range of a clip's media, where the clip shows it. */
const clipRange = (item: ClipPlace, frame: number, durationFrames: number, rate: number) => {
  const at = Math.min(Math.max(Math.round(frame), item.start), item.end - 1);
  const sourceRate = item.clip.source_range.start_time.rate;
  const seconds = sourceSecondsAt(item.clip, (at - item.start) / rate);
  const length = (Math.max(0, durationFrames) / rate) * Math.abs(timeScalarOf(item.clip));
  return timeRange(round3(seconds * sourceRate), round3(length * sourceRate), sourceRate);
};

const patched = (
  marker: Marker,
  edit: Extract<MarkerEdit, { readonly kind: "setMarker" }>,
): Marker => {
  const { resolved: _was, ...meta } = metaOf(marker);
  const resolved = edit.resolved ?? metaOf(marker).resolved === true;
  return {
    ...marker,
    name: edit.name ?? marker.name,
    comment: edit.note ?? marker.comment,
    color: edit.color ?? marker.color,
    metadata: {
      ...marker.metadata,
      [TIMELINE_NAMESPACE]: { ...meta, ...(resolved ? { resolved: true } : {}) },
    },
  };
};

/** Applies one marker edit; an edit naming a marker or clip that is gone does nothing. */
export const applyMarkerEdit = (host: MarkerHost, edit: MarkerEdit, rate: number): void => {
  if (edit.kind === "addMarker") {
    const marker = (range: Marker["marked_range"]): Marker => ({
      OTIO_SCHEMA: "Marker.2",
      name: edit.name ?? "",
      color: edit.color ?? DEFAULT_MARKER_COLOR,
      comment: edit.note ?? "",
      marked_range: range,
      metadata: {
        [TIMELINE_NAMESPACE]: {
          id:
            edit.markerId ??
            newMarkerId(
              `${Math.round(edit.frame)}|${edit.clipId ?? ""}|${edit.name ?? ""}|${edit.note ?? ""}`,
              allIds(host),
            ),
          author: edit.author ?? "user",
        },
      },
    });
    if (edit.clipId === undefined) {
      const frame = Math.max(0, Math.round(edit.frame));
      const length = Math.max(0, Math.round(edit.duration ?? 0));
      host.sequence = [...host.sequence, marker(timeRange(frame, length, rate))];
      return;
    }
    const item = host.clips().find((candidate) => candidate.id === edit.clipId);
    if (item === undefined) return;
    host.setClip(item.id, {
      ...item.clip,
      markers: [
        ...(item.clip.markers ?? []),
        marker(clipRange(item, edit.frame, edit.duration ?? 0, rate)),
      ],
    });
    return;
  }

  const named = (marker: Marker, fallback: string) =>
    markerIdOf(marker, fallback) === edit.markerId;
  if (edit.kind === "removeMarker") {
    host.sequence = host.sequence.filter(
      (marker, index) => !named(marker, sequenceFallback(index)),
    );
    for (const item of host.clips()) {
      const markers = item.clip.markers ?? [];
      const kept = markers.filter((marker, index) => !named(marker, clipFallback(item.id, index)));
      if (kept.length === markers.length) continue;
      const { markers: _removed, ...bare } = item.clip;
      host.setClip(item.id, kept.length === 0 ? bare : { ...item.clip, markers: kept });
    }
    return;
  }

  host.sequence = host.sequence.map((marker, index) => {
    if (!named(marker, sequenceFallback(index))) return marker;
    const { start_time, duration } = marker.marked_range;
    const frame = edit.frame ?? (start_time.value / start_time.rate) * rate;
    const length = edit.duration ?? (duration.value / duration.rate) * rate;
    return {
      ...patched(marker, edit),
      marked_range: timeRange(
        Math.max(0, Math.round(frame)),
        Math.max(0, Math.round(length)),
        rate,
      ),
    };
  });
  for (const item of host.clips()) {
    const markers = item.clip.markers ?? [];
    if (!markers.some((marker, index) => named(marker, clipFallback(item.id, index)))) continue;
    host.setClip(item.id, {
      ...item.clip,
      markers: markers.map((marker, index) => {
        if (!named(marker, clipFallback(item.id, index))) return marker;
        const next = patched(marker, edit);
        if (edit.frame === undefined && edit.duration === undefined) return next;
        const span = clipMarkerSpan(item, marker, rate);
        return {
          ...next,
          marked_range: clipRange(
            item,
            edit.frame ?? span.frame,
            edit.duration ?? span.durationFrames,
            rate,
          ),
        };
      }),
    });
  }
};

/**
 * Sequence markers after [start, end) is cut out of every track and closed up. A marker after
 * the cut moves with the picture it was on; one inside the removed time lands on the cut, so a
 * note is never lost with the frames under it; a range loses the frames cut from under it.
 */
export const rippleMarkers = (
  markers: ReadonlyArray<Marker>,
  start: number,
  end: number,
  rate: number,
): ReadonlyArray<Marker> => {
  if (end <= start) return markers;
  const after = (frame: number) =>
    frame >= end ? frame - (end - start) : frame > start ? start : frame;
  return markers.map((marker) => {
    const { start_time, duration } = marker.marked_range;
    const from = Math.round((start_time.value / start_time.rate) * rate);
    const to = from + Math.round((duration.value / duration.rate) * rate);
    const movedFrom = after(from);
    const movedTo = Math.max(movedFrom, after(to));
    return movedFrom === from && movedTo === to
      ? marker
      : { ...marker, marked_range: timeRange(movedFrom, movedTo - movedFrom, rate) };
  });
};

/** Sequence markers at or after `at` moved `by` frames: `rippleMarkers` when it closes up. */
export const shiftMarkersFrom = (
  markers: ReadonlyArray<Marker>,
  at: number,
  by: number,
  rate: number,
): ReadonlyArray<Marker> => {
  if (by <= 0) return rippleMarkers(markers, at + by, at, rate);
  return markers.map((marker) => {
    const { start_time, duration } = marker.marked_range;
    const from = Math.round((start_time.value / start_time.rate) * rate);
    if (from < at) return marker;
    return {
      ...marker,
      marked_range: timeRange(from + by, Math.round((duration.value / duration.rate) * rate), rate),
    };
  });
};

/** The timeline with no markers at all, for comparing cuts alone. */
export const withoutMarkers = (timeline: Timeline): Timeline => {
  const { markers: _sequence, ...stack } = timeline.tracks;
  return {
    ...timeline,
    tracks: {
      ...stack,
      children: stack.children.map((track) => ({
        ...track,
        children: track.children.map((child) => {
          if (child.OTIO_SCHEMA !== "Clip.2" || child.markers === undefined) return child;
          const { markers: _clip, ...bare } = child;
          return bare;
        }),
      })),
    },
  };
};

const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " / ");

/**
 * Markers as an agent reads them, one line each, such as
 * `M 240 #m3 user open Cut too early: lose two frames` or, pinned to a clip and resolved,
 * `M 300-360 #m4 agent done on #a1b2 B-roll here`. Empty when there are none.
 */
export const markersText = (timeline: Timeline): string => {
  const markers = timelineMarkers(timeline);
  if (markers.length === 0) return "";
  return [
    "# markers · M frame #markerId author open|done name: note",
    ...markers.map((marker) =>
      [
        "M",
        marker.durationFrames > 0
          ? `${marker.frame}-${marker.frame + marker.durationFrames}`
          : String(marker.frame),
        `#${marker.id}`,
        marker.author,
        marker.resolved ? "done" : "open",
        ...(marker.clipId === null ? [] : [`on #${marker.clipId}`]),
        `${oneLine(marker.name) || "(unnamed)"}${marker.note === "" ? "" : `: ${oneLine(marker.note)}`}`,
      ].join(" "),
    ),
  ].join("\n");
};

const PREMIERE_TAG = /\s*\[stellar: ([a-z, ]+)\]\s*$/;

/**
 * A marker's note as Premiere's comment. Premiere has no field for who made a marker or whether
 * it is resolved, so an agent's or a resolved marker ends with a line like `[stellar: agent,
 * resolved]`, which the pull reads back. A user's open note travels as it is.
 */
export const premiereMarkerComment = (marker: {
  readonly note: string;
  readonly author: MarkerAuthor;
  readonly resolved: boolean;
}): string => {
  const flags = [
    ...(marker.author === "agent" ? ["agent"] : []),
    ...(marker.resolved ? ["resolved"] : []),
  ];
  if (flags.length === 0) return marker.note;
  return `${marker.note}${marker.note === "" ? "" : "\n"}[stellar: ${flags.join(", ")}]`;
};

export const parsePremiereMarkerComment = (
  comment: string,
): { readonly note: string; readonly author: MarkerAuthor; readonly resolved: boolean } => {
  const match = PREMIERE_TAG.exec(comment);
  if (match === null) return { note: comment, author: "user", resolved: false };
  const flags = (match[1] ?? "").split(",").map((flag) => flag.trim());
  return {
    note: comment.slice(0, match.index),
    author: flags.includes("agent") ? "agent" : "user",
    resolved: flags.includes("resolved"),
  };
};
