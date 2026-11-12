import { describe, expect, it } from "vite-plus/test";

import { beatAtFrame, groupBeatsBySection, scriptTicks } from "./scriptBeats";

const beats = [
  { id: "intro", startFrame: 0, endFrame: 40 },
  { id: "cut", startFrame: null, endFrame: null },
  // Said later in the script but placed earlier on the timeline than "middle".
  { id: "end", startFrame: 200, endFrame: 260 },
  { id: "middle", startFrame: 60, endFrame: 120 },
];

describe("beatAtFrame", () => {
  it("picks the last beat to start, whatever the script order", () => {
    expect(beatAtFrame(beats, 0, 24)).toBe("intro");
    expect(beatAtFrame(beats, 90, 24)).toBe("middle");
    expect(beatAtFrame(beats, 230, 24)).toBe("end");
  });

  it("holds a beat through a short pause and drops it after a long one", () => {
    expect(beatAtFrame(beats, 50, 24)).toBe("intro");
    expect(beatAtFrame(beats, 144, 24)).toBe("middle");
    expect(beatAtFrame(beats, 145, 24)).toBeNull();
    expect(beatAtFrame(beats, 400, 24)).toBeNull();
  });

  it("has no beat before the first one or when none are placed", () => {
    expect(beatAtFrame(beats.slice(2), 10, 24)).toBeNull();
    expect(beatAtFrame([beats[1]!], 10, 24)).toBeNull();
  });
});

describe("groupBeatsBySection", () => {
  it("groups consecutive beats and keeps a repeated heading apart", () => {
    const grouped = groupBeatsBySection([
      { section: null },
      { section: "Hook" },
      { section: "Hook" },
      { section: "Body" },
      { section: "Hook" },
    ]);
    expect(grouped.map((group) => [group.section, group.beats.length])).toEqual([
      [null, 1],
      ["Hook", 2],
      ["Body", 1],
      ["Hook", 1],
    ]);
  });
});

describe("scriptTicks", () => {
  it("marks where each placed line starts, named by its section and first words", () => {
    expect(
      scriptTicks([
        { id: "b1", startFrame: 12, section: "Hook", text: "This is the best fried chicken" },
        { id: "b2", startFrame: null, section: "Hook", text: "Cut from the edit" },
        {
          id: "b3",
          startFrame: 90,
          section: null,
          text: "One two three four five six seven eight nine ten",
        },
      ]),
    ).toEqual([
      { id: "b1", frame: 12, label: "Hook: This is the best fried chicken" },
      { id: "b3", frame: 90, label: "One two three four five six seven eight…" },
    ]);
  });
});
