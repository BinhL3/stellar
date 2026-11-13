import { describe, expect, it } from "vite-plus/test";

import { applyEdits } from "./edits.ts";
import { footageStringout } from "./footage.ts";
import { linearTimeWarp } from "./speed.ts";
import { timelineWords, wordRange, wordsText } from "./words.ts";

// Two clips at 60 fps: a.MOV on frames 0-120, b.MOV on 120-180.
const stringout = footageStringout(
  [
    { target: "Footage/a.MOV", duration: 2, width: 1080, height: 1920 },
    { target: "Footage/b.MOV", duration: 1, width: 1080, height: 1920 },
  ],
  "/media",
);

const transcripts = new Map([
  [
    "Footage/a.MOV",
    [
      { w: "Hãy", start: 0.5, end: 0.6 },
      { w: "subscribe", start: 0.6, end: 1 },
      // Degenerate timings, as the aligner writes them: no length, then one word over seconds.
      { w: "cho", start: 1, end: 1 },
      { w: "kênh", start: 1, end: 9 },
      { w: "unheard", start: 2.5, end: 2.6 },
    ],
  ],
]);

describe("timelineWords", () => {
  it("places the words of each audio clip in timeline frames and numbers them", () => {
    const view = timelineWords(stringout, transcripts);
    expect(wordsText(view).split("\n").slice(1)).toEqual([
      "A1 0-120 #1:0 a.MOV",
      "1:Hãy@30 2:subscribe@36 3:cho@60 4:kênh@60",
      "A1 120-180 #1:1 b.MOV (no transcript)",
    ]);
    // A word ends where the next begins; the last is clamped to its clip.
    expect(view.clips[0]?.words?.map((word) => word.endFrame)).toEqual([36, 60, 60, 120]);
  });

  it("follows a cut: the words removed are gone and the rest move with their clip", () => {
    const range = wordRange(timelineWords(stringout, transcripts), 2, 2);
    expect(range).toEqual({ start: 36, end: 60 });
    const cut = applyEdits(stringout, [{ kind: "removeRange", start: 36, end: 60, ripple: true }]);
    expect(wordsText(timelineWords(cut, transcripts)).split("\n").slice(1, 5)).toEqual([
      "A1 0-36 #1:0 a.MOV",
      "1:Hãy@30",
      "A1 36-96 #1:0~60 a.MOV",
      "2:cho@36 3:kênh@36",
    ]);
  });

  it("drops a removed word whose quiet lead-in the cut left on the clip before", () => {
    // "subscribe" starts at frame 36; an edge moved onto quiet at 42 leaves six frames of it.
    const cut = applyEdits(stringout, [{ kind: "removeRange", start: 42, end: 60, ripple: true }]);
    expect(wordsText(timelineWords(cut, transcripts)).split("\n").slice(1, 3)).toEqual([
      "A1 0-42 #1:0 a.MOV",
      "1:Hãy@30",
    ]);
  });

  it("places words by a clip's speed, and lists none for a clip that plays backwards", () => {
    const warped = (speed: number) => ({
      ...stringout,
      tracks: {
        ...stringout.tracks,
        children: stringout.tracks.children.map((track) => ({
          ...track,
          children: track.children.map((child) =>
            child.OTIO_SCHEMA === "Clip.2" && child.name === "a.MOV"
              ? { ...child, effects: [linearTimeWarp(speed)] }
              : child,
          ),
        })),
      },
    });
    // At half speed a word half a second into the source is heard a second into the clip.
    expect(
      wordsText(timelineWords(warped(0.5), transcripts))
        .split("\n")
        .slice(1, 3),
    ).toEqual(["A1 0-120 #1:0 a.MOV", "1:Hãy@60 2:subscribe@72"]);
    const reversed = timelineWords(warped(-1), transcripts);
    expect(wordsText(reversed).split("\n")[1]).toBe("A1 0-120 #1:0 a.MOV (plays in reverse)");
    expect(reversed.count).toBe(0);
  });

  it("wraps long clips onto several lines", () => {
    const many = new Map([
      [
        "Footage/a.MOV",
        Array.from({ length: 30 }, (_, index) => ({
          w: "word",
          start: index / 20,
          end: (index + 1) / 20,
        })),
      ],
    ]);
    const lines = wordsText(timelineWords(stringout, many)).split("\n").slice(2, -1);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 100)).toBe(true);
    expect(lines.join(" ").split(" ")).toHaveLength(30);
  });
});

describe("wordRange", () => {
  const view = timelineWords(stringout, transcripts);

  it("gives the frames a run of words covers", () => {
    expect(wordRange(view, 1, 2)).toEqual({ start: 30, end: 60 });
    expect(wordRange(view, 3, 4)).toEqual({ start: 60, end: 120 });
  });

  it("says why a range can't be cut", () => {
    expect(wordRange(view, 2, 1)).toBe("fromWord 2 is after toWord 1");
    expect(wordRange(view, 4, 5)).toBe("no word 5 (the timeline has 4 words)");
    expect(wordRange(view, 3, 3)).toContain("have no length");
  });
});
