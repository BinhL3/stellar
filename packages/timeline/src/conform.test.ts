import { describe, expect, it } from "vite-plus/test";

import {
  adoptedTies,
  conformedPath,
  conformNames,
  conformProgress,
  conformState,
  conformSummary,
  type ConformTie,
  type FileStamp,
  type MediaIndex,
  type MediaTiming,
  mediaKey,
  needsConform,
  tieState,
} from "./conform.ts";

const timing = (stamp: FileStamp, rates: ReadonlyArray<number>): MediaTiming => ({
  ...stamp,
  frames: 600,
  duration: 10,
  fps: rates[0] ?? 60,
  variable: rates.length > 1,
  segments: rates.map((fps, i) => ({ start: i * 2, end: i * 2 + 2, fps })),
});

const original = "Footage/Day 1/IMG_8152.MOV";
const copy = "Footage/Day 1/IMG_8152_5994.mov";
const shot: FileStamp = { size: 1000, modified: 50 };
const tie: ConformTie = {
  original,
  copy,
  originalSize: 1000,
  originalModified: 50,
  copySize: 400,
};

describe("conform", () => {
  it("names the copy beside its original and pairs their derived data by name", () => {
    expect(conformedPath(original)).toBe(copy);
    expect(conformedPath("Footage/v1.2/clip")).toBe("Footage/v1.2/clip_5994.mov");
    expect(conformNames(original)).toEqual(["IMG_8152", "IMG_8152_5994"]);
    expect(conformNames(copy)).toEqual(["IMG_8152_5994", "IMG_8152"]);
    expect(mediaKey(`/Volumes/SSD/Jollibee/${copy}`, "/Volumes/SSD/Jollibee")).toBe(copy);
    expect(mediaKey(copy, "/Volumes/SSD/Jollibee")).toBe(copy);
  });

  it("conforms only clips that switch rate, whatever their one rate is", () => {
    expect(needsConform(timing(shot, [60, 30, 60]))).toBe(true);
    // A steady 30 fps clip in a 59.94 sequence, or a jittery 59.99, is left as it is.
    expect(needsConform(timing(shot, [29.97]))).toBe(false);
    expect(needsConform(timing(shot, [59.99]))).toBe(false);
  });

  it("tells a current copy from a stale or missing one", () => {
    expect(tieState(tie, shot, { size: 400, modified: 70 })).toBe("fresh");
    expect(tieState(tie, { size: 1000, modified: 51 }, { size: 400, modified: 70 })).toBe("stale");
    expect(tieState(tie, { size: 1001, modified: 50 }, { size: 400, modified: 70 })).toBe("stale");
    // A copy of another size is not the copy that was recorded.
    expect(tieState(tie, shot, { size: 399, modified: 70 })).toBe("missing");
    expect(tieState(tie, shot, undefined)).toBe("missing");
    expect(tieState(tie, undefined, { size: 400, modified: 70 })).toBe("missing");
  });

  it("resolves ties both ways and lists what still needs a copy", () => {
    const other = "Footage/Day 1/IMG_8168.MOV";
    const replaced = "Footage/Day 1/IMG_8170.MOV";
    const index: MediaIndex = {
      version: 1,
      media: {
        [original]: timing(shot, [60, 30]),
        [copy]: timing({ size: 400, modified: 70 }, [59.94]),
        [other]: timing(shot, [60, 30, 60]),
        "Footage/Day 1/IMG_8169.MOV": timing(shot, [60]),
        // Read from a file that has since been replaced: not trusted until it is read again.
        [replaced]: timing({ size: 5, modified: 5 }, [60, 30]),
      },
      conformed: [tie],
    };
    const stamps = new Map<string, FileStamp>([
      [original, shot],
      [copy, { size: 400, modified: 70 }],
      [other, shot],
      ["Footage/Day 1/IMG_8169.MOV", shot],
      [replaced, shot],
    ]);
    const state = conformState(index, stamps);
    expect([...state.copyOf]).toEqual([[original, copy]]);
    expect([...state.originalOf]).toEqual([[copy, original]]);
    expect(state.pending).toEqual([other]);
    expect(state.stale).toEqual([]);
    expect(conformSummary(index, state)).toBe(
      `Frame rates: 3 variable-rate clips have frame tables; conformed to 59.94 (cut from the copy): ${original} -> IMG_8152_5994.mov; switch frame rate partway and still need conforming before they are cut (video_footage action conform): ${other}.`,
    );

    // The original was re-exported after the copy was made: the copy no longer stands for it.
    const moved = conformState(
      index,
      new Map([...stamps, [original, { size: 1000, modified: 99 }]]),
    );
    expect(moved.copyOf.size).toBe(0);
    expect(moved.stale).toEqual([original]);
    // A hand-made copy is reported but never queued to be overwritten.
    const byHand = conformState(
      { ...index, conformed: [{ ...tie, adopted: true, originalModified: 49 }] },
      stamps,
    );
    expect(byHand.stale).toEqual([original]);
    expect(byHand.pending).toEqual([other]);
    expect(
      conformSummary({ version: 1, media: {}, conformed: [] }, conformState(index, new Map())),
    ).toBe(null);
  });

  it("adopts a copy found beside its original, once", () => {
    const stamps = new Map<string, FileStamp>([
      [original, shot],
      [copy, { size: 400, modified: 70 }],
      ["Footage/Day 1/IMG_9000_5994.mov", { size: 1, modified: 1 }],
    ]);
    const empty: MediaIndex = { version: 1, media: {}, conformed: [] };
    expect(adoptedTies(empty, stamps)).toEqual([{ ...tie, adopted: true }]);
    expect(adoptedTies({ ...empty, conformed: [tie] }, stamps)).toEqual([]);
  });

  it("reads how far a conform has got from ffmpeg's progress lines", () => {
    expect(conformProgress("out_time_us=5000000", 20)).toBe(0.25);
    expect(conformProgress("out_time_us=25000000", 20)).toBe(1);
    expect(conformProgress("progress=continue", 20)).toBe(null);
    expect(conformProgress("out_time_us=N/A", 20)).toBe(null);
  });
});
