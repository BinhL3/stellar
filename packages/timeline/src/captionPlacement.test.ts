import { describe, expect, it } from "vite-plus/test";

import { type GrayFrame, placeCaption, rowMotion } from "./captionPlacement.ts";

const WIDTH = 9;
const HEIGHT = 100;
const insets = { top: 0.15, bottom: 0.35, left: 0.1, right: 0.2 };

/** A still textured background with a block that moves sideways over rows `from` to `to`. */
const frames = (from: number, to: number, count = 6): Array<GrayFrame> =>
  Array.from({ length: count }, (_, index) => {
    const data = new Uint8Array(WIDTH * HEIGHT);
    for (let row = 0; row < HEIGHT; row++) {
      for (let column = 0; column < WIDTH; column++) {
        const moving = row >= from && row < to && Math.abs(column - index) <= 1;
        data[row * WIDTH + column] = moving ? 250 : (row * 7 + column * 13) % 120;
      }
    }
    return { width: WIDTH, height: HEIGHT, data };
  });

describe("rowMotion", () => {
  it("is zero where the picture holds still and high where something moves", () => {
    const motion = rowMotion(frames(40, 60));
    expect(motion[10]).toBe(0);
    expect(motion[50]).toBeGreaterThan(20);
  });
});

describe("placeCaption", () => {
  it("sits low in the clear area when nothing moves there", () => {
    const place = placeCaption({ frames: frames(20, 45), insets, height: 0.1 });
    expect([place.top, place.bottom]).toEqual([0.55, 0.65]);
    expect(place.motion).toBe(0);
  });

  it("moves up off a moving subject, never into a covered strip", () => {
    const place = placeCaption({ frames: frames(50, 66), insets, height: 0.1 });
    expect(place.bottom).toBeLessThanOrEqual(0.5);
    expect(place.top).toBeGreaterThanOrEqual(0.15);
    expect(place.motion).toBe(0);
    expect(place.x).toBeCloseTo(0.45);
  });

  it("stays at its usual place without frames to look at", () => {
    expect(placeCaption({ frames: [], insets, height: 0.1 }).y).toBeCloseTo(0.6);
  });
});
