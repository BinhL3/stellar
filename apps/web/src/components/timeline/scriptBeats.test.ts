import { describe, expect, it } from "vite-plus/test";

import { scriptTicks } from "./scriptBeats";

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
