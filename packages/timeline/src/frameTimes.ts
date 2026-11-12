/**
 * A clip's frame timestamp table: when each frame is shown, read from the file rather than
 * assumed from a rate. iPhone footage is variable frame rate and can switch rate partway (60
 * down to 30 in low light), so seconds times one rate names the wrong frame in such a clip.
 *
 * Times are seconds from the first video frame, the clock a transcript of the clip's audio uses.
 */

/** Stored per variable-rate clip as `frames/<key>.json` in the project folder. */
export interface FrameTable {
  readonly version: 1;
  /** Ticks per second: the video stream's own time base, so times stay exact integers. */
  readonly timescale: number;
  readonly frames: number;
  /** Ticks from each frame to the next in presentation order, run-length encoded. */
  readonly runs: ReadonlyArray<readonly [count: number, ticks: number]>;
}

/** A stretch of a clip at one frame rate. */
export interface RateSegment {
  readonly start: number;
  readonly end: number;
  readonly fps: number;
}

/**
 * The table for a stream's presentation timestamps, in ticks. Packets arrive in decode order,
 * so they are sorted; the first frame becomes time zero.
 */
export const frameTableFrom = (pts: ReadonlyArray<number>, timescale: number): FrameTable => {
  const sorted = pts.toSorted((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (let i = 1; i < sorted.length; i++) {
    const ticks = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0);
    const last = runs.at(-1);
    if (last !== undefined && last[1] === ticks) last[0] += 1;
    else runs.push([1, ticks]);
  }
  return { version: 1, timescale, frames: sorted.length, runs };
};

/** Each frame's time in seconds, indexed by frame number. */
export const frameSeconds = (table: FrameTable): Float64Array => {
  const times = new Float64Array(table.frames);
  let index = 0;
  let ticks = 0;
  for (const [count, step] of table.runs) {
    for (let i = 0; i < count && index + 1 < times.length; i++) {
      ticks += step;
      index += 1;
      times[index] = ticks / table.timescale;
    }
  }
  return times;
};

/**
 * The frame for a time: the one on screen then (`floor`), or the nearest frame boundary
 * (`nearest`), which is what a cut wants. Times outside the clip give its first or last frame.
 */
export const frameAt = (
  times: ArrayLike<number>,
  seconds: number,
  mode: "nearest" | "floor" = "nearest",
): number => {
  if (times.length === 0) return 0;
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((times[middle] ?? 0) <= seconds) low = middle;
    else high = middle - 1;
  }
  if (mode === "floor" || low + 1 >= times.length) return low;
  const before = seconds - (times[low] ?? 0);
  const after = (times[low + 1] ?? 0) - seconds;
  return after < before ? low + 1 : low;
};

/** When a frame is shown. Frames past the end continue at the last frame's length. */
export const secondsAt = (times: ArrayLike<number>, frame: number): number => {
  const last = times.length - 1;
  if (last < 0) return 0;
  if (frame <= last) return times[Math.max(0, frame)] ?? 0;
  const step = last > 0 ? (times[last] ?? 0) - (times[last - 1] ?? 0) : 0;
  return (times[last] ?? 0) + (frame - last) * step;
};

/** Frames per second over the whole clip. For display; never multiply seconds by it. */
export const averageRate = (times: ArrayLike<number>): number => {
  const end = times[times.length - 1] ?? 0;
  return end > 0 ? (times.length - 1) / end : 0;
};

/**
 * Whether seconds times the clip's average rate names the wrong frame anywhere. Timestamps
 * rounded to a coarse time base (a 60 fps MKV in milliseconds) stay on their frames and are
 * not variable; one dropped frame shifts every frame after it and is.
 */
export const isVariableRate = (times: ArrayLike<number>): boolean => {
  const rate = averageRate(times);
  for (let i = 0; i < times.length; i++) {
    if (Math.round((times[i] ?? 0) * rate) !== i) return true;
  }
  return false;
};

// A run shorter than this is a hiccup inside its neighbour, not a rate of its own.
const SHORTEST_SEGMENT_SECONDS = 0.1;

/**
 * The stretches of constant frame rate in a clip. One- and two-frame hiccups and rates within
 * a frame per second of each other stay in one segment, so ordinary variable-rate footage is
 * one segment and a clip that switches rate (60 to 30) is several.
 */
export const rateSegments = (times: ArrayLike<number>): Array<RateSegment> => {
  const gaps = Array.from({ length: Math.max(0, times.length - 1) }, (_, i) => {
    return (times[i + 1] ?? 0) - (times[i] ?? 0);
  });
  const rates = gaps.map((gap) => Math.round(1 / gap));
  const rateOver = (from: number, to: number) => {
    const length = (times[to] ?? 0) - (times[from] ?? 0);
    return length > 0 ? (to - from) / length : 0;
  };
  const runs: Array<RateSegment> = [];
  let start = 0;
  for (let k = 1; k <= rates.length; k++) {
    // A single odd frame doesn't end a run; the rate has to stay changed for two.
    const changed =
      rates[k] !== rates[start] && (k + 1 >= rates.length || rates[k + 1] !== rates[start]);
    if (k === rates.length || changed) {
      runs.push({ start: times[start] ?? 0, end: times[k] ?? 0, fps: rateOver(start, k) });
      start = k;
    }
  }
  const merged: Array<RateSegment> = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      (run.end - run.start < SHORTEST_SEGMENT_SECONDS || Math.abs(run.fps - previous.fps) < 1)
    ) {
      const frames =
        (previous.end - previous.start) * previous.fps + (run.end - run.start) * run.fps;
      merged[merged.length - 1] = {
        start: previous.start,
        end: run.end,
        fps: frames / (run.end - previous.start),
      };
    } else merged.push(run);
  }
  return merged;
};

/**
 * The frame of a constant-rate copy that shows an original's frame. A conformed copy keeps the
 * original's clock, so seconds are the same in both and only frame numbers differ.
 */
export const toConformedFrame = (times: ArrayLike<number>, frame: number, rate: number): number =>
  Math.round(secondsAt(times, frame) * rate);

/**
 * The original's frame that a constant-rate copy's frame shows. The conform puts each original
 * frame on its nearest copy frame and repeats it until the next one lands, so this is the last
 * original frame that rounds to this copy frame or an earlier one.
 */
export const fromConformedFrame = (times: ArrayLike<number>, frame: number, rate: number): number =>
  frameAt(times, (frame + 0.5) / rate, "floor");
