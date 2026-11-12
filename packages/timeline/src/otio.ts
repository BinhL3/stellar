/**
 * The subset of OpenTimelineIO JSON this editor reads and writes. Files stay valid OTIO, so any
 * OTIO tool opens them; our data lives under `metadata[TIMELINE_NAMESPACE]` and per-app data under
 * `metadata.premiere` and friends.
 */

export const TIMELINE_NAMESPACE = "stellar";

export interface RationalTime {
  readonly OTIO_SCHEMA: "RationalTime.1";
  readonly value: number;
  readonly rate: number;
}

export interface TimeRange {
  readonly OTIO_SCHEMA: "TimeRange.1";
  readonly start_time: RationalTime;
  readonly duration: RationalTime;
}

export interface ExternalReference {
  readonly OTIO_SCHEMA: "ExternalReference.1";
  readonly target_url: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** A native effect kept by reference. The blob it points to lives in `effects/<sha>.<app>.json`. */
export interface EffectRef {
  readonly ref: `sha256:${string}`;
  readonly app: "premiere";
  /** The effect as the app names it, such as "Transform". */
  readonly kind: string;
  /** What the user calls this instance, such as a preset name; equals `kind` when unnamed. */
  readonly label: string;
  readonly tier: "portable" | "mappable" | "native";
  readonly matchName: string;
  readonly animated: boolean;
}

/**
 * OTIO's constant speed change. A clip's `source_range.duration` stays its length on the track;
 * the media it plays is `duration × |time_scalar|` long, starting at `source_range.start_time`,
 * and a negative scalar plays that span backwards. See `speed.ts`.
 */
export interface LinearTimeWarp {
  readonly OTIO_SCHEMA: "LinearTimeWarp.1";
  readonly name: string;
  readonly effect_name: "LinearTimeWarp";
  readonly time_scalar: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** OTIO's marker colours. Premiere has eight of them; see `markers.ts`. */
export type MarkerColor =
  | "PINK"
  | "RED"
  | "ORANGE"
  | "YELLOW"
  | "GREEN"
  | "CYAN"
  | "BLUE"
  | "PURPLE"
  | "MAGENTA"
  | "BLACK"
  | "WHITE";

/**
 * OTIO's marker. On the stack, `marked_range` is in timeline frames; on a clip it is in the
 * clip's media time, like `source_range`, so it stays on the same picture when the clip is
 * moved or trimmed. Who made it and whether it is resolved are `metadata.stellar`.
 */
export interface Marker {
  readonly OTIO_SCHEMA: "Marker.2";
  readonly name: string;
  readonly color: MarkerColor;
  readonly comment: string;
  readonly marked_range: TimeRange;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface Clip {
  readonly OTIO_SCHEMA: "Clip.2";
  readonly name: string;
  readonly source_range: TimeRange;
  /** Absent when the clip has none, so a timeline without markers reads as it always did. */
  readonly markers?: ReadonlyArray<Marker>;
  /** OTIO's own effects list; only speed lives here, everything else is `metadata.stellar`. */
  readonly effects?: ReadonlyArray<LinearTimeWarp>;
  readonly media_references: { readonly DEFAULT_MEDIA: ExternalReference };
  readonly active_media_reference_key: "DEFAULT_MEDIA";
  readonly enabled: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface Gap {
  readonly OTIO_SCHEMA: "Gap.1";
  readonly name: string;
  readonly source_range: TimeRange;
  readonly enabled: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type TrackChild = Clip | Gap;

export interface Track {
  readonly OTIO_SCHEMA: "Track.1";
  readonly name: string;
  readonly kind: "Video" | "Audio";
  readonly children: ReadonlyArray<TrackChild>;
  readonly enabled: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface Stack {
  readonly OTIO_SCHEMA: "Stack.1";
  readonly name: string;
  readonly children: ReadonlyArray<Track>;
  /** Sequence markers. Absent when there are none. */
  readonly markers?: ReadonlyArray<Marker>;
  readonly enabled: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface Timeline {
  readonly OTIO_SCHEMA: "Timeline.1";
  readonly name: string;
  readonly global_start_time: RationalTime;
  readonly tracks: Stack;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export const rationalTime = (value: number, rate: number): RationalTime => ({
  OTIO_SCHEMA: "RationalTime.1",
  value,
  rate,
});

export const timeRange = (start: number, duration: number, rate: number): TimeRange => ({
  OTIO_SCHEMA: "TimeRange.1",
  start_time: rationalTime(start, rate),
  duration: rationalTime(duration, rate),
});

/** Pretty-printed with sorted keys, so checkpoint diffs show only what changed. */
export const serializeTimeline = (timeline: Timeline): string =>
  `${JSON.stringify(sortKeys(timeline), null, 2)}\n`;

/** Stable JSON for content-addressed blobs and other files we diff. */
export const serializeJson = (value: unknown): string =>
  `${JSON.stringify(sortKeys(value), null, 2)}\n`;

export const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};
