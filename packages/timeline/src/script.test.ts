import { describe, expect, it } from "vite-plus/test";

import { alignBeats, assignBeatIds, beatsText, parseScript } from "./script.ts";
import type { WordsView } from "./words.ts";

/** A timeline saying `speech`, one word every ten frames, split over clips at each `|`. */
const said = (speech: string): WordsView => {
  let index = 0;
  const clips = speech.split("|").map((part, clip) => {
    const words = part
      .trim()
      .split(/\s+/)
      .map((word) => {
        index += 1;
        return { index, word, startFrame: (index - 1) * 10, endFrame: index * 10 };
      });
    return {
      track: "A1",
      clipId: `1:${clip}`,
      name: `clip ${clip}`,
      startFrame: (words[0]?.startFrame ?? 0) as number,
      endFrame: (words.at(-1)?.endFrame ?? 0) as number,
      words,
    };
  });
  return { name: "Cut", rate: 60, count: index, clips };
};

const place = (lines: ReadonlyArray<string>, speech: string) =>
  alignBeats(
    lines.map((text, at) => ({ id: `b${at + 1}`, text })),
    said(speech),
  ).map((beat) => (beat.firstWord === null ? null : [beat.firstWord, beat.lastWord]));

describe("parseScript", () => {
  it("keeps the spoken lines of a script and names their sections", () => {
    const script = [
      "---",
      "status: draft",
      "---",
      "# [Script] Is the X Credit Card Worth It?",
      "Author: Binh Le",
      "Date: October 19, 2026",
      "English · ~75 seconds (estimate)",
      "",
      "## Hook (0-3s)",
      "Before you apply, ask **one** question: will you [use the perks](https://example.com)?",
      "[on-screen: “Your spend > the marketing”] [b-roll: scrolling a statement]",
      "",
      "## Beat 1: Start with your spending",
      "- Don’t start with the welcome offer. [beat] Start with where your money goes.",
      "B-roll: calculator on phone",
      "(pause)",
      "VO: So, is X worth it?",
      "https://example.com/source",
      "> a quote kept for reference",
      "",
      "**Ending**",
      "Comment with your biggest monthly category.",
      "",
      "## Hook options",
      "1. What if the fee is the product?",
      "### Why it stops the scroll",
      "It names the fear.",
      "## Notes",
      "Check the current annual fee.",
    ].join("\n");
    expect(parseScript(script)).toEqual([
      {
        section: "Hook (0-3s)",
        text: "Before you apply, ask one question: will you use the perks?",
      },
      {
        section: "Beat 1: Start with your spending",
        text: "Don’t start with the welcome offer. Start with where your money goes.",
      },
      { section: "Beat 1: Start with your spending", text: "So, is X worth it?" },
      { section: "Ending", text: "Comment with your biggest monthly category." },
    ]);
  });

  it("reads plain Vietnamese text with no headings as beats without a section", () => {
    expect(
      parseScript(
        "Tác giả: Bình\r\n\r\nVề Hà Nội mà phải đặt lịch gặp bạn.\r\n[cảnh: phố cổ]\r\nAi cũng đi làm.",
      ),
    ).toEqual([
      { section: null, text: "Về Hà Nội mà phải đặt lịch gặp bạn." },
      { section: null, text: "Ai cũng đi làm." },
    ]);
  });
});

describe("assignBeatIds", () => {
  it("keeps an id through a light edit and a move, and never reuses one", () => {
    const first = assignBeatIds(
      [],
      [
        { text: "Don't start with the welcome offer." },
        { text: "Take the rewards you'd realistically earn, then subtract the annual fee." },
        { text: "So, is X worth it?" },
      ],
      1,
    );
    expect(first.beats.map((beat) => beat.id)).toEqual(["b1", "b2", "b3"]);

    const second = assignBeatIds(
      first.beats,
      [
        { text: "so is X worth it" },
        { text: "Here is a brand new line about travel." },
        { text: "Take the rewards you would realistically earn, and subtract the annual fee." },
      ],
      first.nextId,
    );
    expect(second.beats.map((beat) => beat.id)).toEqual(["b3", "b4", "b2"]);

    // b1 was dropped above; a line added later doesn't get its id back.
    const third = assignBeatIds(
      second.beats,
      [{ text: "Something else entirely here." }],
      second.nextId,
    );
    expect(third.beats.map((beat) => beat.id)).toEqual(["b5"]);
    expect(third.nextId).toBe(6);
  });
});

describe("alignBeats", () => {
  it("places beats by their words, through fillers, a changed word and punctuation", () => {
    const beats = alignBeats(
      [
        { id: "b1", text: "Don’t start with the welcome offer." },
        { id: "b2", text: "Start with where your money goes every month." },
        { id: "b3", text: "This line was never recorded at all." },
        { id: "b4", text: "So, is X worth it?" },
      ],
      said(
        "Okay um don't start with the welcome offer | start with where uh the money goes every month | so is X worth it",
      ),
    );
    expect(beatsText(beats).split("\n")).toEqual([
      "b1 words 3-8 frames 20-80: Don’t start with the welcome offer.",
      "b2 words 9-17 frames 80-170: Start with where your money goes every month.",
      "b3 not on the timeline: This line was never recorded at all.",
      "b4 words 18-22 frames 170-220: So, is X worth it?",
    ]);
  });

  it("matches Vietnamese whatever its Unicode form, and tells tones apart", () => {
    const lines = ["Hãy subscribe cho kênh của mình".normalize("NFD"), "Mình về Hà Nội rồi"];
    expect(place(lines, "HÃY subscribe cho kênh của mình. Mình về Hà Nội rồi!")).toEqual([
      [1, 6],
      [7, 11],
    ]);
    // Without their marks these are other words: nothing here was said.
    expect(place(lines, "Hay subscribe cho kenh cua minh minh ve ha noi roi")).toEqual([
      null,
      null,
    ]);
  });

  it("picks the take that keeps script order when a line was said twice", () => {
    const lines = [
      "Start with your spending today",
      "Then do the simple math",
      "Know the tradeoff first",
    ];
    // The first line's retake comes after a false start of the second.
    expect(
      place(
        lines,
        "start with your spending today then do the | start with your spending today then do the simple math know the tradeoff first",
      ),
    ).toEqual([
      [9, 13],
      [14, 18],
      [19, 22],
    ]);
    // A line said again after the others doesn't pull them out of order.
    expect(
      place(
        lines,
        "start with your spending today then do the simple math know the tradeoff first start with your spending today",
      ),
    ).toEqual([
      [1, 5],
      [6, 10],
      [11, 14],
    ]);
  });

  it("still places a line the edit moved out of script order", () => {
    expect(
      place(
        ["Start with your spending today", "Then do the simple math", "Know the tradeoff first"],
        "then do the simple math know the tradeoff first start with your spending today",
      ),
    ).toEqual([
      [10, 14],
      [1, 5],
      [6, 9],
    ]);
  });
});
