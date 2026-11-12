/**
 * `<project>/media.json`: each footage clip's frame rates, keyed by path under the media root,
 * and which constant 59.94 copy (`IMG_8152_5994.mov`) stands in for which original. Only a clip
 * that switches rate partway gets a copy; other variable-rate clips cut through a frame table.
 */
import type { RateSegment } from "./frameTimes.ts";

export const MEDIA_INDEX_PATH = "media.json";
export const FRAME_TABLE_DIRECTORY = "frames";

/** Sequences are 59.94, never exactly 60, so that is what a copy is conformed to. */
export const CONFORM_RATE = 60000 / 1001;
const CONFORM_RATE_TEXT = "60000/1001";
const CONFORM_SUFFIX = "_5994";
const CONFORM_NAME = /_5994\.mov$/i;

export interface MediaTiming {
  /** The file these facts were read from; a different size or time means read it again. */
  readonly size: number;
  readonly modified: number;
  readonly frames: number;
  readonly duration: number;
  /** Frames per second over the whole clip. */
  readonly fps: number;
  /** Seconds times `fps` names the wrong frame somewhere in the clip. */
  readonly variable: boolean;
  /** More than one when the rate switches partway; such a clip is conformed whole. */
  readonly segments: ReadonlyArray<RateSegment>;
  /** The frame table, relative to the project folder. Only variable-rate clips have one. */
  readonly table?: string;
}

/** Ties a conformed copy to the original it was made from. */
export interface ConformTie {
  readonly original: string;
  readonly copy: string;
  /** The original as it was when the copy was made, so a replaced original shows as stale. */
  readonly originalSize: number;
  readonly originalModified: number;
  readonly copySize: number;
  /** True for a copy found beside its original rather than made here; it is never rewritten. */
  readonly adopted?: boolean;
}

export interface MediaIndex {
  readonly version: 1;
  readonly media: Readonly<Record<string, MediaTiming>>;
  readonly conformed: ReadonlyArray<ConformTie>;
  /** Files the last run could not read or conform, with why. */
  readonly failed?: Readonly<Record<string, string>>;
}

export const EMPTY_MEDIA_INDEX: MediaIndex = { version: 1, media: {}, conformed: [] };

export interface FileStamp {
  readonly size: number;
  readonly modified: number;
}

const splitExtension = (target: string) => {
  const dot = target.lastIndexOf(".");
  return dot > target.lastIndexOf("/")
    ? ([target.slice(0, dot), target.slice(dot)] as const)
    : ([target, ""] as const);
};

/** Where an original's conformed copy goes: beside it, `<name>_5994.mov`. */
export const conformedPath = (original: string): string =>
  `${splitExtension(original)[0]}${CONFORM_SUFFIX}.mov`;

const isConformedName = (target: string): boolean => CONFORM_NAME.test(target);

/**
 * The names a file's derived data may be kept under: its own, then its conform partner's
 * (`IMG_8152` and `IMG_8152_5994`), without extensions. A transcript made from either applies
 * to both, because a conformed copy keeps the original's clock and audio.
 */
export const conformNames = (target: string): ReadonlyArray<string> => {
  const name = splitExtension(target.slice(target.lastIndexOf("/") + 1))[0];
  return name.endsWith(CONFORM_SUFFIX)
    ? [name, name.slice(0, -CONFORM_SUFFIX.length)]
    : [name, `${name}${CONFORM_SUFFIX}`];
};

/** Only a clip whose rate switches partway is conformed; one steady rate cuts fine as it is. */
export const needsConform = (timing: Pick<MediaTiming, "segments">): boolean =>
  timing.segments.length > 1;

/**
 * Whether a copy still stands for its original: `stale` when the original was replaced after
 * the copy was made, `missing` when either file is gone or the copy is not the one recorded.
 */
export const tieState = (
  tie: ConformTie,
  original: FileStamp | undefined,
  copy: FileStamp | undefined,
): "fresh" | "stale" | "missing" => {
  if (original === undefined || copy === undefined || copy.size !== tie.copySize) return "missing";
  return original.size === tie.originalSize && original.modified === tie.originalModified
    ? "fresh"
    : "stale";
};

export interface ConformState {
  /** Original to copy and copy to original, for ties whose files are both current. */
  readonly copyOf: ReadonlyMap<string, string>;
  readonly originalOf: ReadonlyMap<string, string>;
  /** Originals whose copy was made from an earlier version of the file. */
  readonly stale: ReadonlyArray<string>;
  /** Clips that switch rate and have no current copy. */
  readonly pending: ReadonlyArray<string>;
}

/** Sorts a project's ties and rate-switching clips by what is on disk now. */
export const conformState = (
  index: MediaIndex,
  stamps: ReadonlyMap<string, FileStamp>,
): ConformState => {
  const copyOf = new Map<string, string>();
  const originalOf = new Map<string, string>();
  const stale: Array<string> = [];
  // A hand-made copy is reported as stale but never queued, so it is never overwritten.
  const keptByHand = new Set<string>();
  for (const tie of index.conformed) {
    const state = tieState(tie, stamps.get(tie.original), stamps.get(tie.copy));
    if (state === "fresh") {
      copyOf.set(tie.original, tie.copy);
      originalOf.set(tie.copy, tie.original);
    } else if (state === "stale") {
      stale.push(tie.original);
      if (tie.adopted === true) keptByHand.add(tie.original);
    }
  }
  const pending = Object.entries(index.media)
    .filter(([target, timing]) => {
      const stamp = stamps.get(target);
      const current =
        stamp !== undefined && stamp.size === timing.size && stamp.modified === timing.modified;
      return (
        current &&
        needsConform(timing) &&
        !copyOf.has(target) &&
        !originalOf.has(target) &&
        !keptByHand.has(target)
      );
    })
    .map(([target]) => target)
    .toSorted();
  return { copyOf, originalOf, stale, pending };
};

/**
 * A copy found beside its original with nothing recorded, as copies made by hand before
 * Stellar are. It is taken as current: there is no telling what the original was back then.
 */
export const adoptedTies = (
  index: MediaIndex,
  stamps: ReadonlyMap<string, FileStamp>,
): Array<ConformTie> => {
  const tied = new Set(index.conformed.flatMap((tie) => [tie.original, tie.copy]));
  const adopted: Array<ConformTie> = [];
  for (const [original, stamp] of stamps) {
    if (isConformedName(original) || tied.has(original)) continue;
    const copy = conformedPath(original);
    const copyStamp = stamps.get(copy);
    if (copyStamp === undefined || tied.has(copy)) continue;
    adopted.push({
      original,
      copy,
      originalSize: stamp.size,
      originalModified: stamp.modified,
      copySize: copyStamp.size,
      adopted: true,
    });
  }
  return adopted;
};

/** A timeline's `target_url` as the index keys it: relative to the media root. */
export const mediaKey = (target: string, mediaRoot: string): string =>
  target.startsWith(`${mediaRoot}/`) ? target.slice(mediaRoot.length + 1) : target;

/**
 * The ffmpeg run that conforms a whole clip, matching the conform this pipeline did by hand:
 * frames duplicated or dropped onto a 59.94 grid without changing the clock, hardware HEVC at
 * 45 Mb/s, and uncompressed audio so its length and sync don't move. Rotation is baked into
 * the picture by ffmpeg's autorotate. Progress is printed to stdout as `out_time_us=` lines.
 */
export const conformArguments = (input: {
  readonly source: string;
  readonly output: string;
  /** `hevc_videotoolbox` on a Mac; `libx265` where there is no hardware encoder. */
  readonly encoder: string;
}): Array<string> => [
  "-v",
  "error",
  "-nostdin",
  "-y",
  "-hwaccel",
  "auto",
  "-i",
  input.source,
  // iPhone files also carry metadata tracks a MOV can't take back; picture and sound only.
  "-map",
  "0:v:0",
  "-map",
  "0:a?",
  "-vf",
  `fps=${CONFORM_RATE_TEXT},setsar=1`,
  "-c:v",
  input.encoder,
  "-b:v",
  "45M",
  // QuickTime and Safari only play HEVC tagged this way; ffmpeg's default is hev1.
  "-tag:v",
  "hvc1",
  ...(input.encoder === "libx265" ? ["-preset", "fast"] : []),
  "-c:a",
  "pcm_s16le",
  "-map_metadata",
  "0",
  "-progress",
  "pipe:1",
  "-nostats",
  "-f",
  "mov",
  input.output,
];

/** Megabytes a conformed copy takes: 45 Mb/s of picture plus 48 kHz 16-bit stereo. */
export const conformedMegabytes = (seconds: number): number => Math.round(seconds * 5.8);

/** How far a conform has got, from a line of ffmpeg's `-progress` output, as 0 to 1. */
export const conformProgress = (line: string, duration: number): number | null => {
  const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
  if (match === null || duration <= 0) return null;
  return Math.min(1, Number(match[1]) / 1_000_000 / duration);
};

/** One line per clip for an agent: what was conformed, what is stale, what still needs it. */
export const conformSummary = (index: MediaIndex, state: ConformState): string | null => {
  const variable = Object.values(index.media).filter((timing) => timing.variable).length;
  const parts = [
    ...(state.copyOf.size > 0
      ? [
          `conformed to 59.94 (cut from the copy): ${[...state.copyOf]
            .map(([original, copy]) => `${original} -> ${copy.slice(copy.lastIndexOf("/") + 1)}`)
            .join(", ")}`,
        ]
      : []),
    ...(state.stale.length > 0
      ? [`copy is older than its original, conform again: ${state.stale.join(", ")}`]
      : []),
    ...(state.pending.length > 0
      ? [
          `switch frame rate partway and still need conforming before they are cut (video_footage action conform): ${state.pending.join(", ")}`,
        ]
      : []),
  ];
  if (parts.length === 0 && variable === 0) return null;
  return `Frame rates: ${variable} variable-rate clips have frame tables${parts.length > 0 ? `; ${parts.join("; ")}` : ""}.`;
};
