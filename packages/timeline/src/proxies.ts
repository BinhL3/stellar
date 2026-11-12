/**
 * Proxies are small preview copies of a project's media, made once so playback stays smooth on
 * long timelines. They live in `<project>/proxies/` with `index.json` keyed by each clip's
 * `target_url`; paths in the index are relative to the project directory.
 */
export const PROXY_DIRECTORY = "proxies";
export const PROXY_INDEX_PATH = `${PROXY_DIRECTORY}/index.json`;

export interface ProxyStrip {
  readonly file: string;
  /** Seconds of source between tiles. Tile `i` shows the frame at `i * every`. */
  readonly every: number;
  readonly count: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
}

export interface ProxyEntry {
  readonly key: string;
  /** The original's display size, after rotation. Premiere's Scale is relative to it. */
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  /** H.264 in MP4, or VP9 with an alpha channel in WebM when the source has transparency. */
  readonly video?: string;
  /** Absent on entries from builds that didn't check; those are made again. */
  readonly alpha?: boolean;
  /** The video's nominal frames per second. */
  readonly fps?: number;
  /**
   * Present when the frame rate changes partway, as iPhone footage can (60 down to 30 and
   * back): each entry is the second a new rate starts at. Seconds times a single rate lands
   * on the wrong frame in such a clip, so it must be conformed whole before it is cut.
   */
  readonly rateChanges?: ReadonlyArray<RateChange>;
  readonly audio?: string;
  readonly strip?: ProxyStrip;
  /** JSON of `{ perSecond, peaks }`, peaks 0–100. */
  readonly peaks?: string;
  /**
   * A WebP or PNG the player draws in place of a still no browser decodes (PSD, TIFF, HEIC,
   * camera raw). It may be smaller than the original; `width` and `height` stay the original's.
   */
  readonly still?: string;
}

export interface RateChange {
  readonly at: number;
  readonly fps: number;
}

/**
 * Where a clip's frame rate changes, from its frame timestamps: frames are counted per second,
 * and a second more than a quarter away from the current rate starts a new one. A clip at one
 * rate gives an empty list. The last, partial second is ignored.
 */
export const rateChangesFrom = (frameTimes: ReadonlyArray<number>): Array<RateChange> => {
  const perSecond = new Map<number, number>();
  for (const time of frameTimes) {
    const second = Math.floor(time);
    perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
  }
  const seconds = [...perSecond.keys()].toSorted((a, b) => a - b).slice(0, -1);
  const changes: Array<RateChange> = [];
  let current: number | null = null;
  for (const second of seconds) {
    const fps = perSecond.get(second) ?? 0;
    if (current === null || Math.abs(fps - current) / current > 0.25) {
      changes.push({ at: second, fps });
      current = fps;
    }
  }
  return changes.length > 1 ? changes : [];
};

export interface ProxyIndex {
  readonly version: 1;
  readonly media: Readonly<Record<string, ProxyEntry>>;
  /** Present while a build is running; the index is rewritten as each file finishes. */
  readonly building?: { readonly done: number; readonly total: number };
  /** Media files the last build could not make proxies for. */
  readonly failed?: number;
  /** Why each of those files has no proxy or rendition, by its `target_url`. */
  readonly failures?: Readonly<Record<string, string>>;
  /** Why the last build made nothing at all, such as ffmpeg not being installed. */
  readonly error?: string;
  /**
   * Entry keys come from each file's path relative to the media root, so they survive the drive
   * moving. Absent on an index whose keys held the absolute path; its proxies are adopted.
   */
  readonly keys?: 2;
}

export interface ProxyPeaks {
  readonly perSecond: number;
  readonly peaks: ReadonlyArray<number>;
}

/** Long edge of a video proxy, in pixels. A 9:16 preview panel rarely shows more than this. */
export const PROXY_LONG_EDGE = 960;
/** Proxies key every 12 frames, so a seek decodes at most 11 frames past a keyframe. */
export const PROXY_GOP = 12;
export const STRIP_TILE_HEIGHT = 54;
export const MAX_STRIP_TILES = 300;
export const PEAKS_PER_SECOND = 50;

export const stripSpacing = (duration: number): { every: number; count: number } => {
  const every = Math.max(1, duration / MAX_STRIP_TILES);
  return { every, count: Math.max(1, Math.ceil(duration / every)) };
};

/** Max absolute amplitude per window of 16-bit mono samples, scaled to 0–100. */
export const peaksFromPcm = (pcm: Uint8Array, samplesPerPeak: number): Array<number> => {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Math.floor(pcm.byteLength / 2);
  const peaks: Array<number> = [];
  for (let start = 0; start < samples; start += samplesPerPeak) {
    let max = 0;
    const end = Math.min(samples, start + samplesPerPeak);
    for (let i = start; i < end; i++) max = Math.max(max, Math.abs(view.getInt16(i * 2, true)));
    peaks.push(Math.round((max / 32768) * 100));
  }
  return peaks;
};

export const STILL_PATH =
  /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|tiff?|psd|dng|cr[23]|nef|arw|raf|orf|rw2)$/i;

/** Long edge of a still's rendition. The player draws stills no larger than this. */
export const STILL_RENDITION_EDGE = 1600;

export type StillFormat = "heic" | "tiff" | "psd" | "raw";

/** The kind of still no browser draws, which needs a rendition; null for the ones they do. */
export const stillFormat = (file: string): StillFormat | null => {
  const extension = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? "";
  if (extension === "heic" || extension === "heif") return "heic";
  if (extension === "tif" || extension === "tiff") return "tiff";
  if (extension === "psd") return "psd";
  return /^(dng|cr[23]|nef|arw|raf|orf|rw2)$/.test(extension) ? "raw" : null;
};

export type StillConverter = "sips" | "ffmpeg" | "heif-dec" | "heif-convert";

export interface StillTools {
  /** macOS's image tool, which reads everything ImageIO does. */
  readonly sips: boolean;
  /** libheif's command-line decoder, under its current or its older name. */
  readonly heif: "heif-dec" | "heif-convert" | null;
}

/**
 * The tools to try for a still, best first, or why none can read it here. ffmpeg itself is
 * taken as present: it reads TIFF and a PSD's flattened composite, but only one tile of a HEIC
 * and no camera raw.
 */
export const stillConverters = (
  format: StillFormat,
  tools: StillTools,
):
  | { readonly converters: ReadonlyArray<StillConverter> }
  | { readonly converters: readonly []; readonly reason: string } => {
  const converters: Array<StillConverter> = [];
  if (tools.sips) converters.push("sips");
  if (format === "tiff" || format === "psd") converters.push("ffmpeg");
  if (format === "heic" && tools.heif !== null) converters.push(tools.heif);
  if (converters.length > 0) return { converters };
  return {
    converters: [],
    reason:
      format === "heic"
        ? "HEIC stills need sips (macOS) or libheif's heif-dec, and neither is installed."
        : "Camera raw stills are only converted on macOS, with sips.",
  };
};

/**
 * The EXIF orientation (1 to 8) a PNG carries in its `eXIf` chunk, or 1. sips keeps a photo's
 * orientation as metadata instead of turning the pixels, and ffmpeg ignores it in a PNG.
 */
export const pngOrientation = (png: Uint8Array): number => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  while (at + 12 <= png.byteLength) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!);
    const body = at + 8;
    if (type === "IDAT" || body + length > png.byteLength) return 1;
    if (type === "eXIf" && length >= 14) {
      const little = png[body] === 0x49;
      const ifd = body + view.getUint32(body + 4, little);
      if (ifd + 2 > body + length) return 1;
      const entries = view.getUint16(ifd, little);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > body + length) return 1;
        if (view.getUint16(entry, little) !== 0x0112) continue;
        const value = view.getUint16(entry + 8, little);
        return value >= 1 && value <= 8 ? value : 1;
      }
      return 1;
    }
    at = body + length + 4;
  }
  return 1;
};

/** The ffmpeg filters that turn a picture stored with an EXIF orientation upright. */
export const orientationFilters = (orientation: number): ReadonlyArray<string> =>
  (
    [
      [],
      [],
      ["hflip"],
      ["hflip", "vflip"],
      ["vflip"],
      ["transpose=0"],
      ["transpose=1"],
      ["transpose=3"],
      ["transpose=2"],
    ] as const
  )[orientation] ?? [];

/**
 * What a proxy key is made from: the file's place under the media root when it has one, so the
 * key is the same wherever the drive is mounted. A file outside the root keeps its full path.
 */
export const proxyIdentity = (target: string, mediaRoots: ReadonlyArray<string>): string => {
  const normal = target.replaceAll("\\", "/");
  if (!/^(\/|[a-z]:\/)/i.test(normal)) return normal;
  for (const root of mediaRoots) {
    const prefix = `${root.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
    if (normal.startsWith(prefix)) return normal.slice(prefix.length);
  }
  return normal;
};
