import { describe, expect, it } from "vite-plus/test";

import {
  historySteps,
  RETAIN_DAYS,
  RETAIN_RECENT,
  retainVersions,
  type TimelineVersion,
} from "./versions.ts";

const DAY = 86_400_000;
const version = (index: number, at: number, steps: Partial<TimelineVersion> = {}) =>
  ({
    id: `v${index}`,
    at,
    by: "user",
    label: "Committed",
    changes: [],
    hash: `hash${index}`,
    base: null,
    parent: index > 1 ? `v${index - 1}` : null,
    ...steps,
  }) satisfies TimelineVersion;

describe("retainVersions", () => {
  it("keeps every recent version, then the last of each earlier day", () => {
    // Four versions a day for sixty days, then a long session today.
    const old = Array.from({ length: 240 }, (_, index) =>
      version(index + 1, Math.floor(index / 4) * DAY + (index % 4) * 1000),
    );
    const today = Array.from({ length: RETAIN_RECENT }, (_, index) =>
      version(241 + index, 60 * DAY + index),
    );
    const kept = retainVersions([...old, ...today]);
    expect(kept.slice(-RETAIN_RECENT)).toEqual(today);
    const earlier = kept.slice(0, -RETAIN_RECENT);
    // One per day, the day's last, for the newest thirty of those days; oldest first.
    expect(earlier).toHaveLength(RETAIN_DAYS);
    expect(earlier.map((kept) => kept.id).slice(0, 2)).toEqual(["v124", "v128"]);
    expect(earlier.at(-1)?.id).toBe("v240");
    // Nothing is dropped until there is more than the recent window.
    expect(retainVersions(today)).toBe(today);
  });
});

describe("historySteps", () => {
  it("steps back through parents and forward again after an undo", () => {
    const history = (versions: ReadonlyArray<TimelineVersion>) => ({
      version: 1 as const,
      next: versions.length + 1,
      base: null,
      versions,
    });
    const three = [version(1, 0), version(2, 1), version(3, 2)];
    expect(historySteps(history(three))).toEqual({ undo: "v2", redo: null });
    // v4 is the undo of v3: it holds v2's text, undoes on to v1 and redoes to v3.
    const undone = [...three, version(4, 3, { parent: "v1", redo: "v3" })];
    expect(historySteps(history(undone))).toEqual({ undo: "v1", redo: "v3" });
    // A step whose version has been thinned out is not offered.
    expect(historySteps(history(undone.slice(1)))).toEqual({ undo: null, redo: "v3" });
    expect(historySteps(history([]))).toEqual({ undo: null, redo: null });
  });
});
