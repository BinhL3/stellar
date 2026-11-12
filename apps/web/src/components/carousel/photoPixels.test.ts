import { describe, expect, it } from "vite-plus/test";

import { averagePixels, type ReadRows } from "./photoPixels";

/** A picture from rows of `[r, g, b, a]` pixels, and the rows asked of it. */
const picture = (pixels: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>) => {
  const height = pixels.length;
  const width = pixels[0]?.length ?? 0;
  const data = new Uint8ClampedArray(pixels.flat(2));
  const asked: Array<string> = [];
  const rows: ReadRows = (y, count) => {
    asked.push(`${y}+${count}`);
    return data.subarray(y * width * 4, (y + count) * width * 4);
  };
  return { rows, size: { width, height }, whole: { x: 0, y: 0, width, height }, asked };
};

const grey = (value: number) => [value, value, value, 255];

describe("averagePixels", () => {
  it("gives each pixel the mean of the area under it, whole pixels or parts of them", () => {
    const source = picture([
      [grey(0), grey(100), grey(200), grey(40)],
      [grey(20), grey(120), grey(220), grey(60)],
    ]);
    // Two by two blocks.
    expect([
      ...averagePixels(source.rows, source.size, source.whole, source.whole, {
        width: 2,
        height: 1,
      }),
    ]).toEqual([60, 60, 60, 255, 130, 130, 130, 255]);
    // Three pixels made from four: the middle one takes half of each neighbour's share.
    expect([
      ...averagePixels(
        source.rows,
        source.size,
        { x: 0, y: 0, width: 4, height: 1 },
        source.whole,
        { width: 3, height: 1 },
      ),
    ]).toEqual([25, 25, 25, 255, 150, 150, 150, 255, 80, 80, 80, 255]);
    // Rows are read as they are needed, never the whole picture for one target row.
    expect(source.asked).toEqual(["0+2", "0+1"]);
  });

  it("counts only the shown part of the picture, and weights colour by alpha", () => {
    const source = picture([[grey(200), grey(200), grey(50), grey(50)]]);
    // A pixel half off the picture's left edge is the half that is on it, and solid.
    expect([
      ...averagePixels(
        source.rows,
        source.size,
        { x: -1, y: 0, width: 2, height: 1 },
        source.whole,
        { width: 1, height: 1 },
      ),
    ]).toEqual([200, 200, 200, 255]);
    // A crop's neighbours stay out of its edge pixels.
    expect([
      ...averagePixels(
        source.rows,
        source.size,
        { x: 1, y: 0, width: 2, height: 1 },
        { x: 0, y: 0, width: 2, height: 1 },
        { width: 1, height: 1 },
      ),
    ]).toEqual([200, 200, 200, 255]);
    // Wholly outside: nothing.
    expect([
      ...averagePixels(
        source.rows,
        source.size,
        { x: 4, y: 0, width: 2, height: 1 },
        source.whole,
        { width: 1, height: 1 },
      ),
    ]).toEqual([0, 0, 0, 0]);

    const cutout = picture([
      [
        [255, 0, 0, 255],
        [0, 0, 255, 0],
      ],
    ]);
    // A transparent pixel's colour does not tint its neighbour.
    expect([
      ...averagePixels(cutout.rows, cutout.size, cutout.whole, cutout.whole, {
        width: 1,
        height: 1,
      }),
    ]).toEqual([255, 0, 0, 128]);
  });
});
