import type { LaidOutClip } from "@t3tools/timeline/layout";
import { describe, expect, it } from "vite-plus/test";

import { clipTimes, poseAt } from "./clipTransform";

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
});
