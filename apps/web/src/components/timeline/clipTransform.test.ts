import type { LaidOutClip } from "@t3tools/timeline/layout";
import { describe, expect, it } from "vite-plus/test";

import { clipSourceAt, clipTimes, cssFontOf, cubicBezier, poseAt } from "./clipTransform";

describe("poseAt", () => {
  it("interpolates keyframes linearly and holds the ends", () => {
    const transform = {
      position: [0.5, 0.25],
      keyframes: {
        scale: [
          [0, 50],
          [2, 60],
        ] as const,
      },
    };
    expect(poseAt(transform, -1).scale).toBe(0.5);
    expect(poseAt(transform, 1).scale).toBeCloseTo(0.55);
    expect(poseAt(transform, 5).scale).toBe(0.6);
    expect(poseAt(transform, 1)).toMatchObject({ x: 0.5, y: 0.25, opacity: 1, gainDb: 0 });
  });

  it("eases between keyframes with the curve the first one carries, and holds where told", () => {
    const transform = {
      crop_left: 10,
      keyframes: {
        // CSS's ease-in-out, then a hold, then linear.
        opacity: [
          [0, 0, [0.42, 0, 0.58, 1]],
          [1, 100, "hold"],
          [2, 50],
          [3, 0],
        ] as const,
        position: [
          [0, [0, 0], [0.42, 0, 1, 1]],
          [1, [1, 0.5]],
        ] as const,
      },
    };
    // Slow out of the first key, through the middle on time, slow into the second.
    expect(poseAt(transform, 0.25).opacity).toBeCloseTo(0.129, 2);
    expect(poseAt(transform, 0.5).opacity).toBeCloseTo(0.5);
    expect(poseAt(transform, 0.75).opacity).toBeCloseTo(0.871, 2);
    // Held until the next key, which then ramps as before.
    expect(poseAt(transform, 1.9).opacity).toBe(1);
    expect(poseAt(transform, 2.5).opacity).toBeCloseTo(0.25);
    // Both axes of a point ride the same curve, so it stays on its line.
    const eased = poseAt(transform, 0.25);
    expect(eased.x).toBeLessThan(0.25);
    expect(eased.y).toBeCloseTo(eased.x / 2);
    expect(eased).toMatchObject({ cropLeft: 0.1, cropRight: 0 });
  });

  it("solves a bezier that overshoots, as a pop-in's does", () => {
    expect(cubicBezier(0.3333, 1.6, 0.6667, 1, 0.5)).toBeGreaterThan(1);
    expect(cubicBezier(0.25, 0.25, 0.75, 0.75, 0.3)).toBeCloseTo(0.3, 4);
    expect(cubicBezier(0.42, 0, 0.58, 1, 1.5)).toBe(1);
  });
});

describe("clipTimes", () => {
  it("maps a timeline frame into the clip's source, clamped to the clip", () => {
    const item = {
      key: "0:0",
      startFrame: 60,
      endFrame: 120,
      clip: {
        source_range: {
          start_time: { value: 25, rate: 30 },
          duration: { value: 30, rate: 30 },
        },
      },
    } as unknown as LaidOutClip;
    expect(clipTimes(item, 60, 90).source).toBeCloseTo(25 / 30 + 0.5);
    expect(clipTimes(item, 60, 500).offset).toBe(1);
  });

  it("follows a clip's speed and direction, and reaches its handles for a transition", () => {
    const warped = (speed: number) =>
      ({
        key: "0:0",
        startFrame: 60,
        endFrame: 120,
        clip: {
          source_range: {
            start_time: { value: 30, rate: 30 },
            duration: { value: 30, rate: 30 },
          },
          effects: [{ OTIO_SCHEMA: "LinearTimeWarp.1", time_scalar: speed }],
        },
      }) as unknown as LaidOutClip;
    // Half a second in: double speed is a second into the source, reverse half a second from its end.
    expect(clipTimes(warped(2), 60, 90).source).toBeCloseTo(2);
    expect(clipTimes(warped(-1), 60, 90).source).toBeCloseTo(1.5);
    // A quarter second before the clip starts and after it ends, as a dissolve plays it.
    expect(clipSourceAt(warped(2), 60, 45)).toBeCloseTo(0.5);
    expect(clipSourceAt(warped(2), 60, 135)).toBeCloseTo(3.5);
    // Never before the media's first frame.
    expect(clipSourceAt(warped(2), 60, 0)).toBe(0);
  });
});

describe("cssFontOf", () => {
  it("turns a PostScript name into the family and weight a browser knows", () => {
    expect(cssFontOf("BeVietnamPro-SemiBoldItalic")).toEqual({
      family:
        '"Be Vietnam Pro", "BeVietnamPro", "BeVietnamPro-SemiBoldItalic", system-ui, sans-serif',
      weight: 600,
      italic: true,
    });
    expect(cssFontOf("Arial-BoldMT")).toMatchObject({ weight: 700, italic: false });
    expect(cssFontOf("ArialMT").family).toBe('"Arial", "ArialMT", system-ui, sans-serif');
    expect(cssFontOf(undefined).family).toBe("system-ui, sans-serif");
  });
});
