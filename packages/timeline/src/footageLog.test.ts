import { describe, expect, it } from "vite-plus/test";

import { footageClipText, type FootageLogClip, normalizeDescription } from "./footageLog.ts";

const segment = (start: number, end: number, place = "station") => ({
  start,
  end,
  place,
  subject: "train",
  action: "arrives",
  usable: true,
  why: "",
});

describe("normalizeDescription", () => {
  it("keeps segments inside the clip, in order and without overlaps", () => {
    const normalized = normalizeDescription(
      {
        summary: "  Train\narrives   at the station ",
        segments: [
          segment(8, 30, "platform"),
          segment(-2, 4.04),
          segment(3, 9, "stairs"),
          { ...segment(Number.NaN, 1), place: "nowhere" },
          { ...segment(9.9, 9.92), place: "too short" },
          { ...segment(1, 1), usable: false, why: "covered" },
        ],
      },
      10,
    );
    expect(normalized.summary).toBe("Train arrives at the station");
    expect(normalized.segments.map((s) => [s.start, s.end, s.place])).toEqual([
      [0, 4, "station"],
      [4, 9, "stairs"],
      [9, 10, "platform"],
    ]);
  });

  it("keeps why only for unusable stretches", () => {
    const { segments } = normalizeDescription(
      {
        summary: "",
        segments: [
          { ...segment(0, 2), why: "fine" },
          { ...segment(2, 4), usable: false, why: "lens covered" },
        ],
      },
      4,
    );
    expect(segments.map((s) => s.why)).toEqual(["", "lens covered"]);
  });
});

const clip = (overrides: Partial<FootageLogClip>): FootageLogClip => ({
  clip: "Footage/Day 1/IMG_0001.MOV",
  folder: "Day 1",
  duration: 12,
  note: null,
  picture: {
    duration: 12,
    cuts: [],
    segments: [{ start: 0, end: 12, camera: "static", issues: [] }],
  },
  contactSheet: "/home/user/acme/Stellar/footage-log/Day 1/IMG_0001.MOV.jpg",
  description: { summary: "A subway platform", segments: [segment(0, 12)], current: true },
  describeFailed: null,
  words: [],
  ...overrides,
});

describe("the user's note", () => {
  it("comes before the model's description", () => {
    const noted = clip({ note: "Philadelphia station, b-roll" });
    const lines = footageClipText(noted, false).split("\n");
    expect(lines[1]).toBe("note (user's, wins): Philadelphia station, b-roll");
    expect(lines[2]).toBe("seen: A subway platform");
  });

  it("marks a description made before the note changed", () => {
    const text = footageClipText(
      clip({
        note: "Day 2 hotel",
        description: { summary: "A lobby", segments: [], current: false },
      }),
      false,
    );
    expect(text).toContain("seen (before the note changed; redoing): A lobby");
  });
});
