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
  placeBackgroundPhoto,
  slideGuides,
  slideSize,
} from "@t3tools/timeline/carousel";

/**
 * The one routine that draws a slide. The preview calls it at the size on screen and the
 * export at full size, so the picture the user approves is the picture that is posted.
 */
export type SlideContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type PhotoLookup = (src: string) => ImageBitmap | null;

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
    const bitmap = photos(placement.src);
    if (bitmap === null) missing.push(placement.src);
    else {
      const box = placeBackgroundPhoto(placement, size, bitmap);
      context.save();
      context.translate(box.cx, box.cy);
      context.rotate(radians(box.rotation));
      context.drawImage(bitmap, -box.width / 2, -box.height / 2, box.width, box.height);
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
      const bitmap = photos(layer.src);
      if (bitmap === null) {
        missing.push(layer.src);
        drawMissing(context, layer.width, layer.height);
      } else {
        const crop = coverCrop(layer, bitmap);
        context.drawImage(
          bitmap,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
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

/**
 * The pictures a render request asks for, drawn with `drawSlide`. An export is each slide at
 * its exact pixel size; `slides` and `sheet` are smaller pictures for an agent to look at.
 */
export const renderRequest = async (
  document: CarouselDocument,
  request: Pick<CarouselRenderRequest, "kind" | "format" | "slides" | "width">,
  photos: PhotoLookup,
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
    const missing = drawSlide(context, document, index, photos, scale);
    if (missing.length > 0) throw missingPhotos(missing);
    images.push(await encode(canvas, request.format));
  }
  return images;
};
