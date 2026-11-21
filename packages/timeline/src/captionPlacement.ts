/**
 * Where a caption goes on the frames it covers, without a model: the frames are averaged into
 * one picture, where the background holds still and a moving subject (a face talking, hands)
 * smears. How far each frame strays from that average is the motion; the caption takes the
 * band of rows with the least of it, inside the strips the apps leave clear.
 */
import type { Insets } from "./safeZones.ts";

/** A small grayscale frame, row by row, one byte per pixel. */
export interface GrayFrame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** The frames' mean, pixel by pixel. All frames are one size. */
export const averageFrame = (frames: ReadonlyArray<GrayFrame>): Float64Array => {
  const first = frames[0];
  if (first === undefined) return new Float64Array();
  const sum = new Float64Array(first.width * first.height);
  for (const frame of frames) {
    for (let i = 0; i < sum.length; i++) sum[i]! += frame.data[i] ?? 0;
  }
  return sum.map((value) => value / frames.length);
};

/** Each row's motion: how far the frames' pixels stray from their average, 0 to 255. */
export const rowMotion = (frames: ReadonlyArray<GrayFrame>): Float64Array => {
  const first = frames[0];
  if (first === undefined) return new Float64Array();
  const { width, height } = first;
  const mean = averageFrame(frames);
  const rows = new Float64Array(height);
  for (const frame of frames) {
    for (let row = 0; row < height; row++) {
      let stray = 0;
      for (let column = 0; column < width; column++) {
        const at = row * width + column;
        stray += Math.abs((frame.data[at] ?? 0) - mean[at]!);
      }
      rows[row]! += stray / width / frames.length;
    }
  }
  return rows;
};

/**
 * Motion is in grey levels a pixel moves on average; this many cost the same as moving the
 * caption the whole frame's height off its usual place, low in the clear area.
 */
const MOTION_PER_FRAME_HEIGHT = 40;
/** Captions move in steps of this share of the height. */
const POSITION_STEP = 0.025;

export interface CaptionPlace {
  /** The caption's centre, as fractions of the frame. */
  readonly x: number;
  readonly y: number;
  /** Its band, as fractions of the frame's height. */
  readonly top: number;
  readonly bottom: number;
  /** Mean motion in the band, 0 to 255. */
  readonly motion: number;
}

/**
 * The band, `height` of the frame tall, with the least motion between the covered strips.
 * A band low in the clear area is the usual place for captions and wins between equals.
 * With no frames, or a caption taller than the clear area, it goes as low as it can.
 */
export const placeCaption = (input: {
  readonly frames: ReadonlyArray<GrayFrame>;
  readonly insets: Insets;
  /** The caption's height as a fraction of the frame's. */
  readonly height: number;
}): CaptionPlace => {
  const { insets, height } = input;
  const x = (insets.left + 1 - insets.right) / 2;
  const lowest = Math.max(insets.top, 1 - insets.bottom - height);
  const motion = rowMotion(input.frames);
  const rows = motion.length;
  const at = (top: number, mean: number): CaptionPlace => ({
    x,
    y: top + height / 2,
    top,
    bottom: top + height,
    motion: mean,
  });
  if (rows === 0 || lowest <= insets.top) return at(lowest, 0);
  const band = Math.max(1, Math.round(height * rows));
  let best: { top: number; cost: number; mean: number } | null = null;
  // Steps up from the usual place, so neighbouring cues that both move land level.
  for (let top = lowest; top >= insets.top - 1e-9; top -= POSITION_STEP) {
    const first = Math.min(rows - band, Math.round(top * rows));
    let sum = 0;
    for (let row = first; row < first + band; row++) sum += motion[row]!;
    const mean = sum / band;
    const cost = mean + MOTION_PER_FRAME_HEIGHT * (lowest - top);
    if (best === null || cost < best.cost) best = { top, cost, mean };
  }
  return best === null ? at(lowest, 0) : at(best.top, best.mean);
};
