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
