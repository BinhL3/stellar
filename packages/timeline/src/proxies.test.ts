import { describe, expect, it } from "vite-plus/test";

import { MAX_STRIP_TILES, peaksFromPcm, stripSpacing } from "./proxies.ts";

const pcm = (samples: ReadonlyArray<number>) => {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return bytes;
};

describe("proxies", () => {
  it("reads peaks as the loudest sample per window, either polarity, on a 0–100 scale", () => {
    expect(peaksFromPcm(pcm([0, 16384, -32768, 100, 3277]), 2)).toEqual([50, 100, 10]);
  });

  it("spaces strip tiles a second apart until the tile cap, then stretches them", () => {
    expect(stripSpacing(12.5)).toEqual({ every: 1, count: 13 });
    const long = stripSpacing(3600);
    expect(long.count).toBe(MAX_STRIP_TILES);
    expect(long.every).toBe(12);
  });
});
