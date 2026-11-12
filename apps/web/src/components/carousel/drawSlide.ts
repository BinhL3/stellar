import type {
  CarouselDocument,
  CarouselImageFormat,
  CarouselLayer,
  CarouselRenderRequest,
  CarouselTextLayer,
} from "@t3tools/contracts";
import {
  type Box,
  contactSheetLayout,
  coverCrop,
  cssFont,
  EXPORT_JPEG_QUALITY,
  layerBox,
  layersOnSlide,
  layoutText,
  type MeasureText,
  photoResample,
  placeBackgroundPhoto,
  type Rect,
  type Size,
  slideGuides,
  slidePhotos,
  slideSize,
} from "@t3tools/timeline/carousel";

import { averagedFrom } from "./photoPixels";

/**
 * The one routine that draws a slide. The preview calls it at the size on screen and the
 * export at full size, so the picture the user approves is the picture that is posted.
 */
export type SlideContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * A decoded photo. `width` and `height` are the original's, whatever size `image` was decoded
 * at, so a slide is laid out the same from a small copy and from the original.
 */
export interface SlidePhoto extends Size {
  readonly image: ImageBitmap;
  /**
   * Set for an export, where `image` is the original: its pixels averaged down, in place of
   * the canvas's own scaling. See `photoResample`.
   */
  readonly average?: (window: Rect, bounds: Rect, target: Size) => CanvasImageSource;
}
export type PhotoLookup = (src: string) => SlidePhoto | null;

let measuring: OffscreenCanvasRenderingContext2D | null = null;

/** Widths at the layer's true size, whatever scale the slide is drawn at, so lines break the same. */
const measureLayer = (layer: CarouselTextLayer): MeasureText => {
  measuring ??= new OffscreenCanvas(1, 1).getContext("2d");
  const context = measuring;
  if (context === null) return (text) => text.length * layer.size * 0.5;
  const font = cssFont(layer);
  return (text) => {
    context.font = font;
    return context.measureText(text).width;
  };
};

export const boxOf = (layer: CarouselLayer): Box => layerBox(layer, measureLayer);

const radians = (degrees: number) => (degrees * Math.PI) / 180;

const drawText = (context: SlideContext, layer: CarouselTextLayer) => {
  const block = layoutText(layer, measureLayer(layer));
  if (block.box !== null && layer.box !== null) {
    context.fillStyle = layer.box.color;
    context.beginPath();
    context.roundRect(
      block.box.x,
      block.box.y,
      block.box.width,
      block.box.height,
      layer.box.radius,
    );
    context.fill();
  }
  context.font = cssFont(layer);
  context.textBaseline = "middle";
  context.textAlign = "left";
  context.lineJoin = "round";
  const shadowed = () => {
    if (layer.shadow === null) return;
    context.shadowColor = layer.shadow.color;
    context.shadowBlur = layer.shadow.blur;
    context.shadowOffsetX = layer.shadow.offsetX;
    context.shadowOffsetY = layer.shadow.offsetY;
  };
  if (layer.stroke !== null && layer.stroke.width > 0) {
    // Twice the width, under the fill: the inner half is covered, leaving an outline outside.
    context.save();
    shadowed();
    context.strokeStyle = layer.stroke.color;
    context.lineWidth = layer.stroke.width * 2;
    for (const line of block.lines) context.strokeText(line.text, line.x, line.y);
    context.restore();
  } else {
    shadowed();
  }
  context.fillStyle = layer.color;
  for (const line of block.lines) context.fillText(line.text, line.x, line.y);
};

/** Draws the part `crop` of a photo (in the original's pixels) into a box of the layer's space. */
const drawPhoto = (
  context: SlideContext,
  photo: SlidePhoto,
  crop: Rect,
  x: number,
  y: number,
  width: number,
  height: number,
) => {
  const direct = () => {
    const across = photo.image.width / photo.width;
    const down = photo.image.height / photo.height;
    context.drawImage(
      photo.image,
      crop.x * across,
      crop.y * down,
      crop.width * across,
      crop.height * down,
      x,
      y,
      width,
      height,
    );
  };
  if (photo.average === undefined) return direct();
  const { a, b, c, d, e, f } = context.getTransform();
  const turned = Math.abs(b) > 1e-9 || Math.abs(c) > 1e-9;
  const plan = photoResample({
    crop,
    drawn: turned
      ? { x: 0, y: 0, width: width * Math.hypot(a, b), height: height * Math.hypot(c, d) }
      : { x: a * x + e, y: d * y + f, width: width * a, height: height * d },
    turned,
    canvas: context.canvas,
  });
  if (plan.kind === "hidden") return;
  if (plan.kind === "direct") return direct();
  const patch = photo.average(plan.window, crop, plan.target);
  if (!plan.aligned) {
    context.drawImage(patch, x, y, width, height);
    return;
  }
  // Already on the canvas's own pixels: placed as it is, under the clip and opacity in force.
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.drawImage(patch, plan.target.x, plan.target.y);
  context.restore();
};

const drawMissing = (context: SlideContext, width: number, height: number) => {
  context.fillStyle = "#8884";
  context.fillRect(-width / 2, -height / 2, width, height);
};

/**
 * Draws slide `index` at `scale` times its export size. Returns the photos it needed and did
 * not have, so an export can refuse to write a slide with a hole in it. `hidden` leaves one
 * layer out, for the moment its text is being typed over the canvas.
 */
export const drawSlide = (
  context: SlideContext,
  document: CarouselDocument,
  index: number,
  photos: PhotoLookup,
  scale: number,
  hidden?: string | null,
): Array<string> => {
  const slide = document.slides[index];
  if (slide === undefined) return [];
  const size = slideSize(document.ratio);
  const missing: Array<string> = [];
  context.save();
  context.scale(scale, scale);
  context.beginPath();
  context.rect(0, 0, size.width, size.height);
  context.clip();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.fillStyle = slide.background.color;
  context.fillRect(0, 0, size.width, size.height);
  const placement = slide.background.photo;
  if (placement !== null) {
    const photo = photos(placement.src);
    if (photo === null) missing.push(placement.src);
    else {
      const box = placeBackgroundPhoto(placement, size, photo);
      context.save();
      context.translate(box.cx, box.cy);
      context.rotate(radians(box.rotation));
      drawPhoto(
        context,
        photo,
        { x: 0, y: 0, width: photo.width, height: photo.height },
        -box.width / 2,
        -box.height / 2,
        box.width,
        box.height,
      );
      context.restore();
    }
  }
  for (const { layer, offsetX } of layersOnSlide(document, index)) {
    if (layer.id === hidden) continue;
    context.save();
    context.translate(layer.x + offsetX, layer.y);
    context.rotate(radians(layer.rotation));
    if (layer.kind === "text") drawText(context, layer);
    else {
      context.globalAlpha = layer.opacity;
      if (layer.radius > 0) {
        context.beginPath();
        context.roundRect(
          -layer.width / 2,
          -layer.height / 2,
          layer.width,
          layer.height,
          layer.radius,
        );
        context.clip();
      }
      const photo = photos(layer.src);
      if (photo === null) {
        missing.push(layer.src);
        drawMissing(context, layer.width, layer.height);
      } else {
        drawPhoto(
          context,
          photo,
          coverCrop(layer, photo),
          -layer.width / 2,
          -layer.height / 2,
          layer.width,
          layer.height,
        );
      }
    }
    context.restore();
  }
  context.restore();
  return missing;
};

/** Size of the selection's handles, in screen pixels. */
export const HANDLE = 10;
/** How far above the frame the rotate handle sits, in screen pixels. */
export const ROTATE_REACH = 26;

/** Guides and the selection frame, over the preview only; an export never draws them. */
export const drawOverlay = (
  context: SlideContext,
  document: CarouselDocument,
  scale: number,
  options: { readonly guides: boolean; readonly selected: Box | null; readonly accent: string },
) => {
  const size = slideSize(document.ratio);
  context.save();
  if (options.guides) {
    const { grid, safe, counter } = slideGuides(document.ratio);
    context.lineWidth = 1;
    // What the profile grid crops away, dimmed.
    context.fillStyle = "#0008";
    context.fillRect(0, 0, grid.x * scale, size.height * scale);
    context.fillRect((grid.x + grid.width) * scale, 0, grid.x * scale, size.height * scale);
    context.setLineDash([6, 4]);
    context.strokeStyle = "#ffffffcc";
    context.strokeRect(safe.x * scale, safe.y * scale, safe.width * scale, safe.height * scale);
    context.strokeStyle = "#ff5a5acc";
    context.strokeRect(
      counter.x * scale,
      counter.y * scale,
      counter.width * scale,
      counter.height * scale,
    );
  }
  const box = options.selected;
  if (box !== null) {
    context.setLineDash([]);
    context.translate(box.cx * scale, box.cy * scale);
    context.rotate(radians(box.rotation));
    const width = box.width * scale;
    const height = box.height * scale;
    context.strokeStyle = options.accent;
    context.lineWidth = 1.5;
    context.strokeRect(-width / 2, -height / 2, width, height);
    context.beginPath();
    context.moveTo(0, -height / 2);
    context.lineTo(0, -height / 2 - ROTATE_REACH);
    context.stroke();
    context.fillStyle = "#ffffff";
    for (const [x, y] of [
      [width / 2, height / 2],
      [-width / 2, height / 2],
      [width / 2, -height / 2],
      [-width / 2, -height / 2],
    ] as const) {
      context.fillRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
      context.strokeRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
    }
    context.beginPath();
    context.arc(0, -height / 2 - ROTATE_REACH, HANDLE / 2, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.restore();
};

const MIME: Record<CarouselImageFormat, string> = { jpeg: "image/jpeg", png: "image/png" };

const encode = async (canvas: OffscreenCanvas, format: CarouselImageFormat) =>
  new Uint8Array(
    await (
      await canvas.convertToBlob({ type: MIME[format], quality: EXPORT_JPEG_QUALITY })
    ).arrayBuffer(),
  );

const canvasOf = (width: number, height: number) => {
  const canvas = new OffscreenCanvas(width, height);
  // sRGB is what Instagram expects and converts everything else to.
  const context = canvas.getContext("2d", { colorSpace: "srgb" });
  if (context === null) throw new Error("This browser can't draw the slides.");
  return { canvas, context };
};

const missingPhotos = (missing: ReadonlyArray<string>) =>
  new Error(`Couldn't load ${[...new Set(missing)].join(", ")}, so the slide would have a hole.`);

/** A photo's original, decoded at full size; null when it can't be loaded. */
export type OriginalPhoto = (src: string) => Promise<ImageBitmap | null>;

/**
 * Draws one slide for an export from its photos' originals, each resampled once to the pixels
 * it covers. The originals are decoded for this slide and let go after it, so an export holds
 * one slide's photos at a time however many the post has.
 */
export const drawExportSlide = async (
  context: SlideContext,
  document: CarouselDocument,
  index: number,
  original: OriginalPhoto,
  scale: number,
): Promise<Array<string>> => {
  const photos = new Map<string, SlidePhoto>();
  try {
    for (const src of slidePhotos(document, index)) {
      const image = await original(src);
      if (image === null) continue;
      photos.set(src, {
        image,
        width: image.width,
        height: image.height,
        average: averagedFrom(image),
      });
    }
    return drawSlide(context, document, index, (src) => photos.get(src) ?? null, scale);
  } finally {
    for (const photo of photos.values()) photo.image.close();
  }
};

/**
 * The pictures a render request asks for, drawn with `drawSlide`. An export is each slide at
 * its exact pixel size, from the photos' originals; `slides` and `sheet` are smaller pictures
 * for an agent to look at, from the copies the editor already holds.
 */
export const renderRequest = async (
  document: CarouselDocument,
  request: Pick<CarouselRenderRequest, "kind" | "format" | "slides" | "width">,
  photos: PhotoLookup,
  original: OriginalPhoto,
): Promise<Array<Uint8Array>> => {
  const size = slideSize(document.ratio);
  const indexes = request.slides.map((id) => {
    const index = document.slides.findIndex((slide) => slide.id === id);
    if (index < 0) throw new Error(`Slide ${id} is no longer in the carousel.`);
    return index;
  });
  if (request.kind === "sheet") {
    const sheet = contactSheetLayout(indexes.length, size, request.width);
    const { canvas, context } = canvasOf(sheet.width, sheet.height);
    context.fillStyle = "#1c1d20";
    context.fillRect(0, 0, sheet.width, sheet.height);
    for (const [position, index] of indexes.entries()) {
      const cell = sheet.cells[position];
      if (cell === undefined) continue;
      context.save();
      context.translate(cell.x, cell.y);
      const missing = drawSlide(context, document, index, photos, cell.width / size.width);
      context.restore();
      if (missing.length > 0) throw missingPhotos(missing);
    }
    return [await encode(canvas, request.format)];
  }
  const scale = request.width / size.width;
  const images: Array<Uint8Array> = [];
  for (const index of indexes) {
    const { canvas, context } = canvasOf(request.width, Math.round(size.height * scale));
    const missing =
      request.kind === "export"
        ? await drawExportSlide(context, document, index, original, scale)
        : drawSlide(context, document, index, photos, scale);
    if (missing.length > 0) throw missingPhotos(missing);
    images.push(await encode(canvas, request.format));
  }
  return images;
};
