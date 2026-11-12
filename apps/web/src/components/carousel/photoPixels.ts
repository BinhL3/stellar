import type { Rect, Size } from "@t3tools/timeline/carousel";

/** `count` rows of a picture from row `y` down, as RGBA bytes, the picture's width to a row. */
export type ReadRows = (y: number, count: number) => Uint8ClampedArray;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * `window` of a picture, in its own pixels, averaged down to `target` pixels: each is the mean
 * of the area under it that is inside `bounds` (the part shown), weighted by alpha, and
 * transparent when none of it is. Made for reducing: enlarging gives blocks.
 */
export const averagePixels = (
  rows: ReadRows,
  source: Size,
  window: Rect,
  bounds: Rect,
  target: Size,
): Uint8ClampedArray<ArrayBuffer> => {
  const out = new Uint8ClampedArray(target.width * target.height * 4);
  const across = window.width / target.width;
  const down = window.height / target.height;
  const left = Math.max(0, bounds.x);
  const right = Math.min(source.width, bounds.x + bounds.width);
  const top = Math.max(0, bounds.y);
  const bottom = Math.min(source.height, bounds.y + bounds.height);
  // Where each target column starts in the picture; one past the end closes the last.
  const edges = new Float64Array(target.width + 1);
  for (let column = 0; column <= target.width; column += 1) {
    edges[column] = clamp(window.x + column * across, left, right);
  }
  const sums = new Float64Array(target.width * 4);
  for (let row = 0; row < target.height; row += 1) {
    const from = clamp(window.y + row * down, top, bottom);
    const to = clamp(window.y + (row + 1) * down, top, bottom);
    if (to <= from) continue;
    const first = Math.floor(from);
    const band = rows(first, Math.ceil(to) - first);
    sums.fill(0);
    for (let y = first; y < to; y += 1) {
      const tall = Math.min(y + 1, to) - Math.max(y, from);
      const line = (y - first) * source.width * 4;
      for (let column = 0; column < target.width; column += 1) {
        const start = edges[column] ?? 0;
        const end = edges[column + 1] ?? 0;
        const sum = column * 4;
        for (let x = Math.floor(start); x < end; x += 1) {
          const at = line + x * 4;
          const weight = tall * (Math.min(x + 1, end) - Math.max(x, start)) * (band[at + 3] ?? 0);
          sums[sum] = (sums[sum] ?? 0) + (band[at] ?? 0) * weight;
          sums[sum + 1] = (sums[sum + 1] ?? 0) + (band[at + 1] ?? 0) * weight;
          sums[sum + 2] = (sums[sum + 2] ?? 0) + (band[at + 2] ?? 0) * weight;
          sums[sum + 3] = (sums[sum + 3] ?? 0) + weight;
        }
      }
    }
    for (let column = 0; column < target.width; column += 1) {
      const sum = column * 4;
      const alpha = sums[sum + 3] ?? 0;
      if (alpha <= 0) continue;
      const at = (row * target.width + column) * 4;
      out[at] = (sums[sum] ?? 0) / alpha;
      out[at + 1] = (sums[sum + 1] ?? 0) / alpha;
      out[at + 2] = (sums[sum + 2] ?? 0) / alpha;
      out[at + 3] = alpha / ((to - from) * ((edges[column + 1] ?? 0) - (edges[column] ?? 0)));
    }
  }
  return out;
};

// A 48 MP original is 190 MB as bytes; it is read a strip of about this much at a time.
const STRIP_BYTES = 16 * 1024 * 1024;

/** A decoded picture's rows, read off it in strips so its bytes are never all held at once. */
const rowsOf = (bitmap: ImageBitmap): ReadRows => {
  const stripRows = Math.max(1, Math.floor(STRIP_BYTES / (bitmap.width * 4)));
  let strip: {
    readonly y: number;
    readonly rows: number;
    readonly data: Uint8ClampedArray;
  } | null = null;
  let canvas: OffscreenCanvas | null = null;
  return (y, count) => {
    if (strip === null || y < strip.y || y + count > strip.y + strip.rows) {
      const height = Math.min(bitmap.height - y, Math.max(count, stripRows));
      if (canvas === null || canvas.height < height) {
        canvas = new OffscreenCanvas(bitmap.width, height);
      }
      const context = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
      if (context === null) throw new Error("This browser can't read the photo's pixels.");
      // Replaces what the last strip left, transparent pixels included.
      context.globalCompositeOperation = "copy";
      context.imageSmoothingEnabled = false;
      context.drawImage(bitmap, 0, y, bitmap.width, height, 0, 0, bitmap.width, height);
      strip = { y, rows: height, data: context.getImageData(0, 0, bitmap.width, height).data };
    }
    return strip.data.subarray((y - strip.y) * bitmap.width * 4);
  };
};

/** `averagePixels` of a decoded picture, as something a canvas can draw. */
export const averagedFrom =
  (bitmap: ImageBitmap) =>
  (window: Rect, bounds: Rect, target: Size): OffscreenCanvas => {
    const patch = new OffscreenCanvas(target.width, target.height);
    const context = patch.getContext("2d", { colorSpace: "srgb" });
    if (context === null) throw new Error("This browser can't draw the slides.");
    const pixels = averagePixels(rowsOf(bitmap), bitmap, window, bounds, target);
    context.putImageData(new ImageData(pixels, target.width, target.height), 0, 0);
    return patch;
  };
