import type { CarouselDocument, CarouselEdit } from "@t3tools/contracts";
import { applyCarouselEdits, emptyCarousel, slideSize } from "@t3tools/timeline/carousel";
import { expect, it } from "vite-plus/test";

import { drawExportSlide, drawSlide, type SlidePhoto } from "./drawSlide";

const carousel = (
  photos: ReadonlyArray<{ readonly src: string; readonly width: number; readonly height: number }>,
  ...edits: ReadonlyArray<CarouselEdit>
): CarouselDocument => {
  const result = applyCarouselEdits(
    { ...emptyCarousel(), photos: photos.map((photo) => ({ ...photo, file: photo.src })) },
    edits,
  );
  if (!result.ok) throw new Error(result.error);
  return result.document;
};

const canvasOf = (size: { readonly width: number; readonly height: number }) => {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
  if (context === null) throw new Error("no 2d context");
  return { canvas, context };
};

const pixelsOf = (context: OffscreenCanvasRenderingContext2D) =>
  context.getImageData(0, 0, context.canvas.width, context.canvas.height).data;

const WIDTH = 1080;
const HEIGHT = 720;
const TIMES = 5;

/** Detail as fine as a slide can hold: every pixel its own value, unrelated to its neighbours. */
const fineDetail = () => {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  let seed = 12345;
  for (let at = 0; at < data.length; at += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    data[at] = at % 4 === 3 ? 255 : seed >>> 24;
  }
  return data;
};

/** `detail` as a camera would hold it: every pixel `TIMES` across and down, as a file. */
const photographed = async (detail: Uint8ClampedArray) => {
  const width = WIDTH * TIMES;
  const height = HEIGHT * TIMES;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = Math.floor(y / TIMES) * WIDTH;
    for (let x = 0; x < width; x += 1) {
      const from = (row + Math.floor(x / TIMES)) * 4;
      data.set(detail.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  const { canvas, context } = canvasOf({ width, height });
  context.putImageData(new ImageData(data, width, height), 0, 0);
  return { width, height, file: await canvas.convertToBlob({ type: "image/png" }) };
};

/** Peak signal-to-noise ratio of the colour channels, in dB; Infinity when they are equal. */
const psnr = (wanted: Uint8ClampedArray, got: Uint8ClampedArray) => {
  let squares = 0;
  let count = 0;
  for (let at = 0; at < wanted.length; at += 1) {
    if (at % 4 === 3) continue;
    squares += ((wanted[at] ?? 0) - (got[at] ?? 0)) ** 2;
    count += 1;
  }
  return squares === 0 ? Infinity : 10 * Math.log10((255 * 255 * count) / squares);
};

it("exports a large photo with all the detail a slide can hold", async () => {
  const detail = fineDetail();
  const photo = await photographed(detail);
  // A 19 MP photo shown whole: five of its pixels to one of the slide's, 1080x720 of them.
  const document = carousel([{ src: "Photos/a.png", width: photo.width, height: photo.height }], {
    kind: "setBackground",
    slide: "s1",
    photo: { src: "Photos/a.png", fit: "fit" },
  });
  const slide = slideSize(document.ratio);
  const exported = canvasOf(slide);
  const missing = await drawExportSlide(
    exported.context,
    document,
    0,
    () => createImageBitmap(photo.file),
    1,
  );
  expect(missing).toEqual([]);
  const shown = exported.context.getImageData(0, (slide.height - HEIGHT) / 2, WIDTH, HEIGHT).data;
  // The canvas's own scaling of the same photo, in one step, reaches 19 dB.
  expect(psnr(detail, shown)).toBeGreaterThan(50);
});

it("lays an export out as the editor shows it, from whatever copy each draws", async () => {
  const flat = async (width: number, height: number, color: string) => {
    const { canvas, context } = canvasOf({ width, height });
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    return createImageBitmap(canvas);
  };
  const sizes = {
    "Photos/back.jpg": { width: 3000, height: 2000, color: "#2060c0" },
    "Photos/front.jpg": { width: 2400, height: 3200, color: "#e0a020" },
  } as const;
  const document = carousel(
    Object.entries(sizes).map(([src, size]) => ({ src, ...size })),
    {
      kind: "setBackground",
      slide: "s1",
      color: "#101010",
      photo: { src: "Photos/back.jpg", fit: "fit", scale: 0.837, offsetX: 31.4, offsetY: -202.7 },
    },
    {
      kind: "addLayer",
      slide: "s1",
      layer: {
        kind: "photo",
        src: "Photos/front.jpg",
        x: 333.3,
        y: 801.6,
        width: 401,
        height: 517,
      },
    },
    {
      kind: "addLayer",
      slide: "s1",
      layer: {
        kind: "photo",
        src: "Photos/front.jpg",
        x: 800,
        y: 1000,
        width: 300,
        height: 300,
        rotation: 17,
        radius: 24,
      },
    },
  );
  const slide = slideSize(document.ratio);

  // The editor draws from copies a quarter the size, the export from the originals.
  const copies = new Map<string, SlidePhoto>();
  for (const [src, { width, height, color }] of Object.entries(sizes)) {
    copies.set(src, { image: await flat(width / 4, height / 4, color), width, height });
  }
  const edited = canvasOf(slide);
  drawSlide(edited.context, document, 0, (src) => copies.get(src) ?? null, 1);
  const exported = canvasOf(slide);
  await drawExportSlide(
    exported.context,
    document,
    0,
    (src) => {
      const size = sizes[src as keyof typeof sizes];
      return flat(size.width, size.height, size.color);
    },
    1,
  );

  const was = pixelsOf(edited.context);
  const is = pixelsOf(exported.context);
  // Flat photos, so any pixel that differs is an edge that moved.
  let differing = 0;
  for (let at = 0; at < was.length; at += 1) {
    if (Math.abs((was[at] ?? 0) - (is[at] ?? 0)) > 2) differing += 1;
  }
  expect(differing).toBe(0);
});
