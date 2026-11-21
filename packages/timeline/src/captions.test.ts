import { describe, expect, it } from "vite-plus/test";

import {
  breakCaptions,
  breakScore,
  type CaptionWord,
  pictureSamples,
  SHORTS_CAPTIONS,
  srtText,
} from "./captions.ts";
import { type Clip, rationalTime, type Timeline, timeRange } from "./otio.ts";

const RATE = 30;

/** Words a third of a second apart, with a pause of `pauses[i]` seconds after word i. */
const spoken = (
  text: string,
  pauses: Readonly<Record<number, number>> = {},
  quiet: Readonly<Record<number, boolean>> = {},
): Array<CaptionWord> => {
  let frame = 0;
  return text.split(" ").map((word, index) => {
    const startFrame = frame;
    const endFrame = startFrame + 8;
    frame = endFrame + 2 + Math.round((pauses[index] ?? 0) * RATE);
    return { text: word, startFrame, endFrame, quietAfter: quiet[index] ?? null };
  });
};

const cueText = (cues: ReturnType<typeof breakCaptions>) =>
  cues.map((cue) => cue.lines.join(" | "));

describe("breakScore", () => {
  it("weighs gap, quiet, punctuation and a phrase opening in English and Vietnamese", () => {
    expect(breakScore("the", "best", 0.05, false)).toBeCloseTo(0.02);
    expect(breakScore("hour.", "And", 0.5, true)).toBeCloseTo(1);
    expect(breakScore("ngon,", "nhưng", 0.1, null)).toBeCloseTo(0.04 + 0.08 + 0.18 + 0.1);
    expect(breakScore("ăn", "thì", 0.1, false)).toBeGreaterThan(breakScore("ăn", "gà", 0.1, false));
    // A capital opening the next word stands in for a full stop the transcript left out.
    expect(breakScore("ngon", "Mình", 0.1, false)).toBeCloseTo(0.04 + 0.15);
    // Sound in the gap outweighs its length: a word nobody transcribed may be there.
    expect(breakScore("so", "good", 0.5, false)).toBeLessThan(breakScore("so", "good", 0.2, true));
  });
});

describe("breakCaptions", () => {
  it("keeps every word as transcribed, in order, in lines that fit", () => {
    const words = spoken(
      "Hãy subscribe cho kênh Ghiền Mì Gõ để không bỏ lỡ những video hấp dẫn",
      { 6: 0.6 },
      { 6: true },
    );
    const cues = breakCaptions(words, [], RATE);
    expect(cues.flatMap((cue) => cue.lines).join(" ")).toBe(
      words.map((word) => word.text).join(" "),
    );
    for (const cue of cues) {
      expect(cue.lines.length).toBeLessThanOrEqual(2);
      for (const line of cue.lines)
        expect(line.length).toBeLessThanOrEqual(SHORTS_CAPTIONS.maxLineChars);
    }
    // The pause after "Gõ" ends a cue.
    expect(cueText(cues).some((text) => text.endsWith("Gõ"))).toBe(true);
  });

  it("breaks at the natural gap, not where the line fills, and ends no line on an article", () => {
    const words = spoken("this is the one tool but nobody uses it", { 4: 0.1 }, { 4: true });
    expect(cueText(breakCaptions(words, [], RATE))).toEqual([
      "this is the one tool",
      "but nobody uses it",
    ]);
    const narrow = { ...SHORTS_CAPTIONS, maxLineChars: 12 };
    expect(cueText(breakCaptions(words.slice(0, 5), [], RATE, narrow))).toEqual([
      "this is | the one tool",
    ]);
  });

  it("keeps a two-word connective together and breaks after a closing particle", () => {
    expect(breakScore("Nhưng", "mà", 0.05, false)).toBeLessThan(
      breakScore("ấy", "Nhưng", 0.05, false),
    );
    expect(breakScore("ngon", "nhé", 0.05, false)).toBeLessThan(
      breakScore("nhé", "mình", 0.05, false),
    );
  });

  it("always breaks at a picture cut and ends the cue there", () => {
    const words = spoken("one two three four");
    const cut = words[2]!.startFrame;
    const cues = breakCaptions(words, [cut], RATE);
    expect(cueText(cues)).toEqual(["one two", "three four"]);
    expect(cues[0]!.endFrame).toBeLessThanOrEqual(cut);
  });

  it("gives a word longer than a line a line of its own, unshortened", () => {
    const cues = breakCaptions(spoken("supercalifragilisticexpialidocious yes"), [], RATE, {
      ...SHORTS_CAPTIONS,
      maxLines: 1,
    });
    expect(cueText(cues)).toEqual(["supercalifragilisticexpialidocious", "yes"]);
  });
});

describe("srtText", () => {
  it("writes numbered cues with millisecond times and a line per caption line", () => {
    expect(
      srtText(
        [
          {
            startFrame: 17,
            endFrame: 54,
            lines: ["Hãy subscribe", "cho kênh"],
            fromWord: 0,
            toWord: 3,
          },
          { startFrame: 3600, endFrame: 3615, lines: ["Gõ"], fromWord: 4, toWord: 4 },
        ],
        RATE,
      ),
    ).toBe(
      "1\n00:00:00,567 --> 00:00:01,800\nHãy subscribe\ncho kênh\n\n2\n00:02:00,000 --> 00:02:00,500\nGõ\n",
    );
  });
});

describe("pictureSamples", () => {
  const clip = (target: string, start: number, frames: number): Clip => ({
    OTIO_SCHEMA: "Clip.2",
    name: target,
    source_range: timeRange(start, frames, RATE),
    media_references: {
      DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: target, metadata: {} },
    },
    active_media_reference_key: "DEFAULT_MEDIA",
    enabled: true,
    metadata: {},
  });
  const timeline: Timeline = {
    OTIO_SCHEMA: "Timeline.1",
    name: "Short",
    global_start_time: rationalTime(0, RATE),
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      enabled: true,
      metadata: {},
      children: [
        {
          OTIO_SCHEMA: "Track.1",
          name: "V1",
          kind: "Video",
          enabled: true,
          metadata: {},
          children: [clip("a.mov", 300, 60)],
        },
        {
          OTIO_SCHEMA: "Track.1",
          name: "V2",
          kind: "Video",
          enabled: true,
          metadata: {},
          children: [clip("", 0, 30), clip("b.mov", 0, 30)],
        },
      ],
    },
    metadata: {},
  };

  it("reads each sample from the top clip with a picture, at its source time", () => {
    expect(pictureSamples(timeline, { startFrame: 0, endFrame: 60 }, 2)).toEqual([
      { target: "a.mov", seconds: 10.5 },
      { target: "b.mov", seconds: 0.5 },
    ]);
  });
});
