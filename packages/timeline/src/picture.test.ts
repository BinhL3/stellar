import { describe, expect, it } from "vite-plus/test";

import {
  analysePicture,
  analysisSize,
  contactSheetTimes,
  globalMotion,
  makePictureMeter,
  PICTURE_SAMPLE_RATE,
} from "./picture.ts";

const size = analysisSize(1080, 1920);

/** A smooth random texture on a canvas wider than the frame, so shifted views stay textured. */
const texture = (seed: number, width: number, height: number) => {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
  const coarse = Array.from({ length: Math.ceil(height / 4) + 2 }, () =>
    Array.from({ length: Math.ceil(width / 4) + 2 }, () => random() * 255),
  );
  return (x: number, y: number) => {
    const cx = Math.max(0, x) / 4;
    const cy = Math.max(0, y) / 4;
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const fx = cx - x0;
    const fy = cy - y0;
    const at = (row: number, column: number) => coarse[row]?.[column] ?? 0;
    return (
      at(y0, x0) * (1 - fx) * (1 - fy) +
      at(y0, x0 + 1) * fx * (1 - fy) +
      at(y0 + 1, x0) * (1 - fx) * fy +
      at(y0 + 1, x0 + 1) * fx * fy
    );
  };
};

/** One RGB frame of `paint`, looking at the canvas from `(left, top)` at `scale`. */
const frame = (
  paint: (x: number, y: number) => number,
  view: { left?: number; top?: number; scale?: number; tint?: number } = {},
) => {
  const { left = 40, top = 40, scale = 1, tint = 0 } = view;
  const rgb = new Uint8Array(size.width * size.height * 3);
  const centreX = size.width / 2;
  const centreY = size.height / 2;
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const value = paint(
        left + centreX + (x - centreX) / scale,
        top + centreY + (y - centreY) / scale,
      );
      const offset = 3 * (y * size.width + x);
      rgb[offset] = Math.min(255, value + tint);
      rgb[offset + 1] = value;
      rgb[offset + 2] = Math.max(0, value - tint);
    }
  }
  return rgb;
};

const analyse = (frames: ReadonlyArray<Uint8Array>) => {
  const meter = makePictureMeter(size);
  // Chunks that don't line up with frames, as ffmpeg's pipe delivers them.
  const all = new Uint8Array(frames.reduce((sum, rgb) => sum + rgb.length, 0));
  let offset = 0;
  for (const rgb of frames) {
    all.set(rgb, offset);
    offset += rgb.length;
  }
  for (let start = 0; start < all.length; start += 7001)
    meter.push(all.subarray(start, start + 7001));
  const track = meter.finish();
  return { track, analysis: analysePicture(track, frames.length / PICTURE_SAMPLE_RATE) };
};

const seconds = (count: number) => Math.round(count * PICTURE_SAMPLE_RATE);
const range = (count: number) => Array.from({ length: count }, (_, index) => index);

describe("globalMotion", () => {
  it("finds the shift between two views of the same texture", () => {
    const paint = texture(1, 300, 400);
    const toGray = (rgb: Uint8Array) =>
      Uint8Array.from({ length: rgb.length / 3 }, (_, i) => rgb[3 * i + 1]!);
    const moved = globalMotion(toGray(frame(paint)), toGray(frame(paint, { left: 43 })), size);
    expect(moved?.dx).toBeCloseTo(-3, 0);
    expect(moved?.dy).toBeCloseTo(0, 0);
    expect(moved?.fit).toBeGreaterThan(0.8);
  });
});

describe("analysePicture", () => {
  it("reads a held camera as static, a steady turn as a pan, and a growing view as a push in", () => {
    const paint = texture(2, 400, 400);
    const frames = [
      ...range(seconds(4)).map(() => frame(paint)),
      // Content moving left: the camera turns right, 3 px a sample.
      ...range(seconds(4)).map((i) => frame(paint, { left: 40 + 3 * i })),
      ...range(seconds(4)).map((i) => frame(paint, { left: 160, scale: 1.04 ** i })),
    ];
    const { analysis } = analyse(frames);
    expect(analysis.cuts).toEqual([]);
    expect(
      analysis.segments.map((segment) => [segment.start, segment.end, segment.camera]),
    ).toEqual([
      [0, 4, "static"],
      [4, 8, "pan right"],
      [8, 12, "push in"],
    ]);
  });

  it("finds a cut between two shots, but not a one-sample flash", () => {
    const first = texture(3, 300, 400);
    const second = texture(4, 300, 400);
    const frames = [
      ...range(seconds(3)).map((i) => (i === 15 ? frame(first, { tint: 120 }) : frame(first))),
      ...range(seconds(3)).map(() => frame(second, { tint: 60 })),
    ];
    const { analysis } = analyse(frames);
    expect(analysis.cuts).toEqual([{ at: 3, kind: "cut" }]);
    expect(analysis.segments.map((segment) => [segment.start, segment.end])).toEqual([
      [0, 3],
      [3, 6],
    ]);
  });

  it("marks a covered lens and a dark stretch as issues", () => {
    const paint = texture(5, 300, 400);
    const dim = (x: number, y: number) => paint(x, y) * 0.2;
    const frames = [
      ...range(seconds(2)).map(() => frame(() => 3)),
      ...range(seconds(2)).map(() => frame(dim)),
      ...range(seconds(2)).map(() => frame(paint)),
    ];
    const { analysis } = analyse(frames);
    expect(analysis.segments.map((segment) => segment.issues)).toEqual([["covered"], ["dark"], []]);
  });
});

describe("contactSheetTimes", () => {
  it("spreads frames over the whole clip, then adds the segments in the biggest gaps", () => {
    const segments = range(30).map((i) => ({
      start: i * 20,
      end: i * 20 + 20,
      camera: "static" as const,
      issues: [],
    }));
    const long = contactSheetTimes({ duration: 600, cuts: [], segments });
    expect(long).toHaveLength(16);
    expect(long).toEqual(long.toSorted((a, b) => a - b));
    // A ten-minute clip is seen to its end, not only through its first segments.
    expect(Math.max(...long)).toBeGreaterThan(560);
    expect(Math.max(...long)).toBeLessThan(600);
    const short = contactSheetTimes({
      duration: 3,
      cuts: [],
      segments: [{ start: 0, end: 3, camera: "static", issues: [] }],
    });
    expect(short).toEqual([0.25, 1.25, 2.25]);
  });
});
