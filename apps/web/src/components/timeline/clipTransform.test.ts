import type { LaidOutClip } from "@t3tools/timeline/layout";
import { describe, expect, it } from "vite-plus/test";

import {
  aboutMotionAnchor,
  clipSourceAt,
  clipTimes,
  cssFontOf,
  cubicBezier,
  type EffectPlan,
  effectPlanOf,
  effectsMatrixAt,
  identityMatrix,
  type Matrix,
  poseAt,
} from "./clipTransform";

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

describe("Transform effects", () => {
  // A 1000 by 800 layer; points are in its own pixels, origin top left.
  const [W, H] = [1000, 800];
  const plan = (...transforms: EffectPlan["transforms"]): EffectPlan => ({
    transforms,
    beforeCrop: 0,
    shutter: 0,
  });
  const matrixOf = (effects: EffectPlan, seconds = 0, from = 0) => {
    const into = identityMatrix();
    const opacity = effectsMatrixAt(effects, seconds, W, H, from, into);
    return { into, opacity };
  };
  const apply = (m: Matrix, x: number, y: number) => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ];
  const expectPoint = (actual: ReadonlyArray<number>, x: number, y: number) => {
    expect(actual[0]).toBeCloseTo(x, 6);
    expect(actual[1]).toBeCloseTo(y, 6);
  };

  it("leaves the layer alone at the effect's defaults", () => {
    expect(matrixOf(plan({}))).toEqual({ into: [1, 0, 0, 1, 0, 0], opacity: 1 });
  });

  it("slides by fractions of the layer and scales about the anchor", () => {
    // Malice Slide In Down starts 1.9 layer heights up: 1520 px for an 800 px layer.
    const slide = matrixOf(plan({ position: [0.5, -1.4] })).into;
    expectPoint(apply(slide, 500, 400), 500, -1120);
    expectPoint(apply(slide, 0, 0), 0, -1520);
    // Uniform: Scale is both axes, about the centre, whatever Scale Width still holds.
    const pop = matrixOf(plan({ scale: 130, scale_width: 10 })).into;
    expectPoint(apply(pop, 500, 400), 500, 400);
    expectPoint(apply(pop, 1000, 800), 1150, 920);
    // Not uniform: Scale is the height and Scale Width the width, as a squishy pop keys them.
    const squish = matrixOf(plan({ uniform_scale: false, scale: 90, scale_width: 120 })).into;
    expectPoint(apply(squish, 1000, 800), 1100, 760);
    const tall = matrixOf(plan({ uniform_scale: false, scale: 50 })).into;
    expectPoint(apply(tall, 1000, 800), 1000, 600);
  });

  it("turns clockwise about a moved anchor, which Position then places", () => {
    // Anchor at the top left corner, placed at the layer's centre, a quarter turn.
    const { into } = matrixOf(plan({ anchor_point: [0, 0], position: [0.5, 0.5], rotation: 90 }));
    expectPoint(apply(into, 0, 0), 500, 400);
    // The top edge now runs down the frame from the anchor.
    expectPoint(apply(into, 100, 0), 500, 500);
    expectPoint(apply(into, 0, 100), 400, 400);
  });

  it("skews along its axis, before rotation and after scale", () => {
    // 45° along the horizontal: a point 100 px below the anchor moves 100 px left.
    const flat = matrixOf(plan({ skew: 45 })).into;
    expectPoint(apply(flat, 500, 500), 400, 500);
    expectPoint(apply(flat, 600, 400), 600, 400);
    // Along the vertical axis the same skew moves points right of the anchor down, and leaves
    // the ones above and below it alone.
    const upright = matrixOf(plan({ skew: 45, skew_axis: 90 })).into;
    expectPoint(apply(upright, 500, 500), 500, 500);
    expectPoint(apply(upright, 600, 400), 600, 500);
    // Scale first, then skew, then rotation: (100, 100) from the anchor doubles to (200, 200),
    // skews to (0, 200), and a quarter turn takes that to (-200, 0).
    const all = matrixOf(plan({ scale: 200, skew: 45, rotation: 90 })).into;
    expectPoint(apply(all, 600, 500), 300, 400);
  });

  it("applies a clip's Transforms in stack order and multiplies their opacity", () => {
    // Halve about the centre, then slide a quarter layer right: the slide is not halved.
    const stacked = plan(
      { scale: 50, opacity: 50 },
      {
        opacity: 50,
        keyframes: {
          position: [
            [0, [0.5, 0.5]],
            [1, [0.75, 0.5]],
          ] as const,
        },
      },
    );
    const { into, opacity } = matrixOf(stacked, 1);
    expectPoint(apply(into, 1000, 800), 1000, 600);
    expect(opacity).toBe(0.25);
    expectPoint(apply(matrixOf(stacked, 0.5).into, 1000, 800), 875, 600);
    // From the second effect on, as Crop needs when it sits between them.
    expectPoint(apply(matrixOf(stacked, 1, 1).into, 1000, 800), 1250, 800);
  });

  it("hands the canvas a map about Motion's anchor, at Motion's scale", () => {
    // The engine draws the layer centred on the origin, 0.5 canvas px to one of its own.
    const still = aboutMotionAnchor(identityMatrix(), W, H, 0.5, 0.5, 0.5);
    expect(still).toEqual([1, 0, 0, 1, 0, 0]);
    // Motion's anchor at the top left: the layer's corner sits on the origin instead.
    expect(aboutMotionAnchor(identityMatrix(), W, H, 0.5, 0, 0)).toEqual([1, 0, 0, 1, 250, 200]);
    // A slide of 1.9 layer heights is 1520 layer px, 760 on the canvas.
    const slide = aboutMotionAnchor(
      matrixOf(plan({ position: [0.5, -1.4] })).into,
      W,
      H,
      0.5,
      0.5,
      0.5,
    );
    expectPoint(apply(slide, -250, -200), -250, -960);
    // A pop to 130% keeps the centre and grows the corner's canvas offset by 1.3.
    const pop = aboutMotionAnchor(matrixOf(plan({ scale: 130 })).into, W, H, 0.5, 0.5, 0.5);
    expectPoint(apply(pop, 250, 200), 325, 260);
  });

  it("reads a clip's Transforms in order around Crop, skipping what it can't draw", () => {
    const first = { scale: 50 };
    const second = { rotation: 10, shutter_angle: 180 };
    const item = (effects: ReadonlyArray<object>) =>
      ({ clip: { metadata: { stellar: { effects } } } }) as unknown as LaidOutClip;
    expect(
      effectPlanOf(
        item([
          { matchName: "AE.ADBE Geometry2", params: first },
          { matchName: "AE.ADBE Drop Shadow" },
          { matchName: "AE.ADBE AECrop" },
          { matchName: "AE.ADBE Geometry2", params: { scale: 1 }, bypassed: true },
          { matchName: "AE.ADBE Geometry", params: second },
        ]),
      ),
    ).toEqual({ transforms: [first, second], beforeCrop: 1, shutter: 180 });
    // One pulled before Transforms were described has nothing to draw from.
    expect(effectPlanOf(item([{ matchName: "AE.ADBE Geometry2" }]))).toBeNull();
  });
});
