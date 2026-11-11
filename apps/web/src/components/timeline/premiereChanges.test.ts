import { describe, expect, it } from "vite-plus/test";

import { capList } from "./premiereChanges";

describe("capList", () => {
  it("hides the rest only when more than one item is left over", () => {
    expect(capList(["a", "b"], 3)).toEqual({ shown: ["a", "b"], more: 0 });
    expect(capList(["a", "b", "c", "d"], 3)).toEqual({ shown: ["a", "b", "c", "d"], more: 0 });
    expect(capList(["a", "b", "c", "d", "e"], 3)).toEqual({ shown: ["a", "b", "c"], more: 2 });
  });
});
