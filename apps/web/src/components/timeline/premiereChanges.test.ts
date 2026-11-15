import { describe, expect, it } from "vite-plus/test";

import { capList, groupByTimeline, summarizeChanges } from "./premiereChanges";

describe("capList", () => {
  it("hides the rest only when more than one item is left over", () => {
    expect(capList(["a", "b"], 3)).toEqual({ shown: ["a", "b"], more: 0 });
    expect(capList(["a", "b", "c", "d"], 3)).toEqual({ shown: ["a", "b", "c", "d"], more: 0 });
    expect(capList(["a", "b", "c", "d", "e"], 3)).toEqual({ shown: ["a", "b", "c"], more: 2 });
  });
});

describe("groupByTimeline", () => {
  const paths = ["timelines/hook.otio", "timelines/hook_Copy.otio"];
  const nameOf = (path: string) => (path.endsWith("Copy.otio") ? "Hook copy" : "Hook");

  it("moves each timeline's prefix into one group, longest label first", () => {
    expect(
      groupByTimeline(
        [
          "New sequence: Outro",
          "hook_Copy: Removed IMG_8149.MOV from V1 at 0:12",
          "hook: Trimmed A.MOV on V1 at 0:03: cut 1.0s off its end",
          "hook_Copy: Moved B.MOV on V1 from 0:20 to 0:18",
        ],
        paths,
        nameOf,
      ),
    ).toEqual([
      { timeline: null, items: ["New sequence: Outro"] },
      {
        timeline: "Hook copy",
        items: ["Removed IMG_8149.MOV from V1 at 0:12", "Moved B.MOV on V1 from 0:20 to 0:18"],
      },
      { timeline: "Hook", items: ["Trimmed A.MOV on V1 at 0:03: cut 1.0s off its end"] },
    ]);
  });
});

describe("summarizeChanges", () => {
  const group = (items: ReadonlyArray<string>) => [{ timeline: null, items }];

  it("names the biggest kinds and folds the rest into other", () => {
    expect(
      summarizeChanges(
        group([
          "Removed a from V1 at 0:01",
          "Removed b from V1 at 0:02",
          "Moved c on V1 from 0:01 to 0:02",
          "Trimmed d on V1 at 0:03: cut 1.0s off its end",
          "Added e to V2 at 0:04",
          "New sequence: Outro",
        ]),
      ),
    ).toBe("2 removed, 1 moved, 1 trimmed, 2 other");
    expect(summarizeChanges(group(["New sequence: A", "New sequence: B"]))).toBe("2 new sequences");
  });
});
