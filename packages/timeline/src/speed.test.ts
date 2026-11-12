import { describe, expect, it } from "vite-plus/test";

import { type Clip, timeRange } from "./otio.ts";
import {
  linearTimeWarp,
  mediaSpanSeconds,
  offsetAtSourceSeconds,
  playSpan,
  reslicedSourceStart,
  sourceSecondsAt,
  timeScalarOf,
} from "./speed.ts";

// 60 timeline frames at 30 fps, starting 100 frames into its media.
const clip = (speed?: number): Clip => ({
  OTIO_SCHEMA: "Clip.2",
  name: "a",
  source_range: timeRange(100, 60, 30),
  ...(speed === undefined ? {} : { effects: [linearTimeWarp(speed)] }),
  media_references: {
    DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: "a.mov", metadata: {} },
  },
  active_media_reference_key: "DEFAULT_MEDIA",
  enabled: true,
  metadata: {},
});

describe("speed", () => {
  it("maps clip time to source time at each speed and direction, and back", () => {
    const cases = [
      // speed, media span, source at 0 s, source at 1 s
      [undefined, [100 / 30, 160 / 30], 100 / 30, 130 / 30],
      [2, [100 / 30, 220 / 30], 100 / 30, 160 / 30],
      [0.5, [100 / 30, 130 / 30], 100 / 30, 115 / 30],
      // Reversed: the same span as forward, entered from its far end.
      [-1, [100 / 30, 160 / 30], 160 / 30, 130 / 30],
      [-2, [100 / 30, 220 / 30], 220 / 30, 160 / 30],
    ] as const;
    for (const [speed, [start, end], atStart, atOne] of cases) {
      const item = clip(speed);
      expect(timeScalarOf(item)).toBe(speed ?? 1);
      expect(mediaSpanSeconds(item).start).toBeCloseTo(start);
      expect(mediaSpanSeconds(item).end).toBeCloseTo(end);
      expect(sourceSecondsAt(item, 0)).toBeCloseTo(atStart);
      expect(sourceSecondsAt(item, 1)).toBeCloseTo(atOne);
      expect(offsetAtSourceSeconds(item, atOne)).toBeCloseTo(1);
    }
    // A transition reaches before the clip's start and past its end.
    expect(sourceSecondsAt(clip(2), -0.5)).toBeCloseTo(70 / 30);
    expect(sourceSecondsAt(clip(-1), 2.5)).toBeCloseTo(85 / 30);
  });

  it("ignores a zero or broken time warp instead of dividing by it", () => {
    expect(timeScalarOf(clip(0))).toBe(1);
    expect(timeScalarOf(clip(Number.NaN))).toBe(1);
  });

  it("keeps the source frames a piece plays when a clip is cut", () => {
    // The piece from frame 20 for 10 frames, of a 60-frame clip.
    expect(reslicedSourceStart(clip(), 30, 20, 10)).toBe(120);
    expect(reslicedSourceStart(clip(2), 30, 20, 10)).toBe(140);
    // Reversed, the clip's head is its media's end: that piece plays frames 130 down to 120.
    expect(reslicedSourceStart(clip(-1), 30, 20, 10)).toBe(130);
    expect(reslicedSourceStart(clip(-2), 30, 20, 10)).toBe(160);
  });

  it("lines the pieces of one clip up along its playback, whatever its speed", () => {
    for (const speed of [1, 2, -1, -2]) {
      const whole = clip(speed);
      const piece = (shift: number, length: number): Clip => ({
        ...whole,
        source_range: timeRange(reslicedSourceStart(whole, 30, shift, length), length, 30),
      });
      const start = playSpan(whole, 30).start;
      expect(playSpan(piece(0, 20), 30).start).toBeCloseTo(start);
      expect(playSpan(piece(20, 40), 30).start).toBeCloseTo(start + 20);
      expect(playSpan(piece(20, 40), 30).end).toBeCloseTo(start + 60);
    }
  });
});
