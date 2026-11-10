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
  readonly video?: string;
  readonly audio?: string;
  readonly strip?: ProxyStrip;
  /** JSON of `{ perSecond, peaks }`, peaks 0–100. */
  readonly peaks?: string;
}

export interface ProxyIndex {
  readonly version: 1;
  readonly media: Readonly<Record<string, ProxyEntry>>;
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
