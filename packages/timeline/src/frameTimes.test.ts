import { describe, expect, it } from "vite-plus/test";

import {
  frameAt,
  frameSeconds,
  frameTableFrom,
  fromConformedFrame,
  isVariableRate,
  rateSegments,
  secondsAt,
  toConformedFrame,
} from "./frameTimes.ts";

/** Presentation times in ticks of 1/600 s: `count` frames, each `ticks` long, from `from`. */
const run = (from: number, count: number, ticks: number) =>
  Array.from({ length: count }, (_, i) => from + i * ticks);

// Two seconds at 60 fps, two at 30, then 60 again: what an iPhone does in low light.
const switching = [...run(0, 120, 10), ...run(1200, 60, 20), ...run(2400, 61, 10)];

describe("frame tables", () => {
  it("stores decode-ordered timestamps as runs from the first frame and reads them back", () => {
    // B-frames arrive out of presentation order, and a stream need not start at zero.
    const table = frameTableFrom([1020, 1000, 1010, 1030, 1050, 1070], 600);
    expect(table).toEqual({
      version: 1,
      timescale: 600,
      frames: 6,
      runs: [
        [3, 10],
        [2, 20],
      ],
    });
    expect([...frameSeconds(table)].map((time) => Math.round(time * 600))).toEqual([
      0, 10, 20, 30, 50, 70,
    ]);
  });

  it("finds the frame for a time where seconds times a rate would miss", () => {
    const times = frameSeconds(frameTableFrom(switching, 600));
    // At 3 s the clip is halfway through its 30 fps stretch: frame 150, not 3 * 60 = 180.
    expect(frameAt(times, 3)).toBe(150);
    expect(secondsAt(times, 150)).toBe(3);
    // Past the stretch the frames are 60 behind a constant 60 fps count.
    expect(frameAt(times, 5)).toBe(240);
    // `nearest` snaps to the closer boundary; `floor` is the frame on screen.
    expect(frameAt(times, 2.02)).toBe(121);
    expect(frameAt(times, 2.02, "floor")).toBe(120);
    expect(frameAt(times, -1)).toBe(0);
    expect(frameAt(times, 99)).toBe(240);
    // Frames past the end keep the last frame's length, so an out point one past the end has a time.
    expect(secondsAt(times, 241)).toBeCloseTo(5 + 1 / 60, 9);
  });

  it("calls a clip variable only when a constant rate would name a wrong frame", () => {
    const steady = frameSeconds(frameTableFrom(run(0, 600, 10), 600));
    expect(isVariableRate(steady)).toBe(false);
    // 60 fps written in milliseconds jitters between 16 and 17 ms but stays on its frames.
    const rounded = Array.from({ length: 600 }, (_, i) => Math.round((i * 1000) / 60));
    expect(isVariableRate(frameSeconds(frameTableFrom(rounded, 1000)))).toBe(false);
    // One dropped frame shifts everything after it.
    const dropped = run(0, 600, 10).filter((_, i) => i !== 100);
    expect(isVariableRate(frameSeconds(frameTableFrom(dropped, 600)))).toBe(true);
  });

  it("splits a clip into rate segments, ignoring dropped frames", () => {
    const dropped = run(0, 600, 10).filter((_, i) => i !== 100 && i !== 301 && i !== 302);
    expect(rateSegments(frameSeconds(frameTableFrom(dropped, 600)))).toHaveLength(1);
    expect(
      rateSegments(frameSeconds(frameTableFrom(switching, 600))).map((segment) => ({
        start: segment.start,
        end: segment.end,
        fps: Math.round(segment.fps),
      })),
    ).toEqual([
      { start: 0, end: 2, fps: 60 },
      { start: 2, end: 4, fps: 30 },
      { start: 4, end: 5, fps: 60 },
    ]);
  });

  it("maps frames between an original and its constant-rate copy through the clock", () => {
    const times = frameSeconds(frameTableFrom(switching, 600));
    const rate = 60000 / 1001;
    // Original frame 150 is at 3 s, which the 59.94 copy shows on frame 180.
    expect(toConformedFrame(times, 150, rate)).toBe(180);
    expect(fromConformedFrame(times, 180, rate)).toBe(150);
    // Two copy frames show each original frame of the 30 fps stretch.
    expect(fromConformedFrame(times, 181, rate)).toBe(150);
  });
});
