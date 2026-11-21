import { describe, expect, it } from "vite-plus/test";

import { coveredEdges, safeZoneInsets } from "./safeZones.ts";

describe("safe zones", () => {
  it("defaults to the most each edge loses on any platform", () => {
    expect(safeZoneInsets()).toEqual({ top: 0.15, bottom: 0.35, left: 0.111, right: 0.178 });
    expect(safeZoneInsets("reels")).toEqual({ top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 });
  });

  it("names each covered strip a box reaches into", () => {
    const insets = safeZoneInsets("reels");
    expect(coveredEdges({ left: 0.2, right: 0.8, top: 0.5, bottom: 0.6 }, insets)).toEqual([]);
    expect(coveredEdges({ left: 0.02, right: 0.99, top: 0.1, bottom: 0.7 }, insets)).toEqual([
      "top",
      "bottom",
      "left",
      "right",
    ]);
  });
});
