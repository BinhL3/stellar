/**
 * The carousel model as pure functions: the edits the UI and agents both make, the layout
 * maths the preview and the export both draw from, and what an export is named and sized.
 * Lengths are pixels of the exported slide, which is always `SLIDE_WIDTH` wide.
 */
import type {
  CarouselDocument,
  CarouselEdit,
  CarouselFont,
  CarouselImageFormat,
  CarouselLayer,
  CarouselPhotoPlacement,
  CarouselRatio,
  CarouselSlide,
  CarouselTextLayer,
} from "@t3tools/contracts";

/** The document, in the project's Stellar folder. Its presence makes the project a carousel. */
export const CAROUSEL_FILE = "carousel.json";
/** Where a carousel's photos live, inside the media root (the Stellar folder's parent). */
export const CAROUSEL_PHOTO_DIRECTORY = "Photos";
export const CAROUSEL_EXPORT_DIRECTORY = "Exports/Carousel";
export const CAROUSEL_CAPTION_FILE = "caption.txt";

export const SLIDE_WIDTH = 1080;
/** Instagram's limits for a feed post: slides, caption characters, hashtags, alt text. */
export const MAX_SLIDES = 20;
export const MAX_CAPTION = 2200;
export const MAX_HASHTAGS = 30;
export const MAX_ALT_TEXT = 1000;

const SLIDE_HEIGHTS: Record<CarouselRatio, number> = { "4:5": 1350, "1:1": 1080, "3:4": 1440 };

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Size {
  readonly x: number;
  readonly y: number;
}

export const slideSize = (ratio: CarouselRatio): Size => ({
  width: SLIDE_WIDTH,
  height: SLIDE_HEIGHTS[ratio],
});

/** The font each family name draws with; the same list is all a browser needs to match an export. */
export const CAROUSEL_FONT_STACKS: Record<CarouselFont, string> = {
  sans: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"Arial Rounded MT Bold", "Trebuchet MS", sans-serif',
  display: 'Impact, "Arial Narrow", sans-serif',
  mono: 'Menlo, Consolas, "Courier New", monospace',
};

export const cssFont = (layer: Pick<CarouselTextLayer, "font" | "size" | "weight">) =>
  `${layer.weight} ${layer.size}px ${CAROUSEL_FONT_STACKS[layer.font]}`;

/**
 * Guides, never drawn into an export. `grid` is what the profile grid keeps of the first slide
 * (its centre, 3:4); `safe` keeps text off the edges; `counter` is where the feed puts "1/5".
 */
export const slideGuides = (ratio: CarouselRatio) => {
  const { width, height } = slideSize(ratio);
  const gridWidth = Math.min(width, (height * 3) / 4);
  const gridHeight = Math.min(height, (width * 4) / 3);
  const margin = 60;
  return {
    grid: {
      x: (width - gridWidth) / 2,
      y: (height - gridHeight) / 2,
      width: gridWidth,
      height: gridHeight,
    },
    safe: { x: margin, y: margin, width: width - margin * 2, height: height - margin * 2 },
    counter: { x: width - 156, y: 24, width: 132, height: 64 },
  } satisfies Record<string, Rect>;
};

const blankSlide = (id: string): CarouselSlide => ({
  id,
  altText: "",
  background: { color: "#ffffff", photo: null },
  layers: [],
});

export const emptyCarousel = (): CarouselDocument => ({
  version: 1,
  ratio: "4:5",
  caption: "",
  slides: [blankSlide("s1")],
  photos: [],
  nextId: 2,
});

const COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const PHOTO_KEYS = ["src", "x", "y", "width", "height", "rotation", "opacity", "radius", "span"];
const TEXT_KEYS = [
  "text",
  "x",
  "y",
  "rotation",
  "font",
  "size",
  "weight",
  "color",
  "align",
  "maxWidth",
  "lineHeight",
  "stroke",
  "shadow",
  "box",
];

const between = (name: string, value: number, min: number, max: number) =>
  Number.isFinite(value) && value >= min && value <= max
    ? null
    : `${name} must be between ${min} and ${max}`;

const firstProblem = (...problems: ReadonlyArray<string | null>) =>
  problems.find((problem) => problem !== null) ?? null;

const colorProblem = (name: string, color: string) =>
  COLOR.test(color) ? null : `${name} must be a hex colour such as #1a1a1a`;

const photoProblem = (document: CarouselDocument, src: string) =>
  document.photos.some((photo) => photo.src === src)
    ? null
    : `no photo ${src} in this project (import it first)`;

// A layer may sit partly or wholly off its slide (a panorama does), but not out of reach.
const REACH = SLIDE_WIDTH * MAX_SLIDES;

const layerProblem = (document: CarouselDocument, layer: CarouselLayer): string | null => {
  const placed = firstProblem(
    between("x", layer.x, -REACH, REACH),
    between("y", layer.y, -REACH, REACH),
    between("rotation", layer.rotation, -360, 360),
  );
  if (placed !== null) return placed;
  if (layer.kind === "photo") {
    return firstProblem(
      photoProblem(document, layer.src),
      between("width", layer.width, 8, REACH),
      between("height", layer.height, 8, REACH),
      between("opacity", layer.opacity, 0, 1),
      between("radius", layer.radius, 0, REACH),
      Number.isInteger(layer.span) ? between("span", layer.span, 1, MAX_SLIDES) : "span is whole",
    );
  }
  return firstProblem(
    layer.text.length > 2000 ? "text is at most 2000 characters" : null,
    between("size", layer.size, 8, 800),
    between("weight", layer.weight, 100, 900),
    between("maxWidth", layer.maxWidth, 40, REACH),
    between("lineHeight", layer.lineHeight, 0.6, 3),
    colorProblem("color", layer.color),
    layer.stroke === null
      ? null
      : firstProblem(
          colorProblem("stroke.color", layer.stroke.color),
          between("stroke.width", layer.stroke.width, 0, 80),
        ),
    layer.shadow === null
      ? null
      : firstProblem(
          colorProblem("shadow.color", layer.shadow.color),
          between("shadow.blur", layer.shadow.blur, 0, 200),
          between("shadow.offsetX", layer.shadow.offsetX, -200, 200),
          between("shadow.offsetY", layer.shadow.offsetY, -200, 200),
        ),
    layer.box === null
      ? null
      : firstProblem(
          colorProblem("box.color", layer.box.color),
          between("box.padding", layer.box.padding, 0, 400),
          between("box.radius", layer.box.radius, 0, 400),
        ),
  );
};

const placementProblem = (document: CarouselDocument, photo: CarouselPhotoPlacement) =>
  firstProblem(
    photoProblem(document, photo.src),
    between("photo.scale", photo.scale, 0.05, 20),
    between("photo.offsetX", photo.offsetX, -REACH, REACH),
    between("photo.offsetY", photo.offsetY, -REACH, REACH),
    between("photo.rotation", photo.rotation, -360, 360),
  );

const slideProblem = (document: CarouselDocument, slide: CarouselSlide): string | null =>
  firstProblem(
    slide.altText.length > MAX_ALT_TEXT ? `alt text is at most ${MAX_ALT_TEXT} characters` : null,
    colorProblem("color", slide.background.color),
    slide.background.photo === null ? null : placementProblem(document, slide.background.photo),
    ...slide.layers.map((layer) => {
      const problem = layerProblem(document, layer);
      return problem === null ? null : `${layer.id}: ${problem}`;
    }),
  );

/** What is wrong with a document as a whole, or null. Edits never leave one invalid. */
export const carouselProblem = (document: CarouselDocument): string | null => {
  if (document.slides.length === 0) return "A carousel keeps at least one slide.";
  if (document.slides.length > MAX_SLIDES) {
    return `Instagram takes at most ${MAX_SLIDES} slides in one post.`;
  }
  if (document.caption.length > MAX_CAPTION) {
    return `The caption is at most ${MAX_CAPTION} characters (it has ${document.caption.length}).`;
  }
  const ids = new Set<string>();
  for (const slide of document.slides) {
    for (const id of [slide.id, ...slide.layers.map((layer) => layer.id)]) {
      if (ids.has(id)) return `Two things share the id ${id}.`;
      ids.add(id);
    }
    const problem = slideProblem(document, slide);
    if (problem !== null) return `${slide.id}: ${problem}`;
  }
  return null;
};

const clampIndex = (index: number | undefined, length: number) =>
  index === undefined ? length : Math.max(0, Math.min(length, Math.round(index)));

const moved = <A>(items: ReadonlyArray<A>, from: number, to: number): Array<A> => {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item as A);
  return next;
};

const DEFAULT_TEXT: Omit<CarouselTextLayer, "id" | "text" | "x" | "y"> = {
  kind: "text",
  font: "sans",
  size: 64,
  weight: 700,
  color: "#111111",
  align: "center",
  maxWidth: 900,
  rotation: 0,
  lineHeight: 1.15,
  stroke: null,
  shadow: null,
  box: null,
};

const fullBleed = (src: string): CarouselPhotoPlacement => ({
  src,
  fit: "fill",
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  rotation: 0,
});

type LayerInput = NonNullable<CarouselEdit["layer"]>;

const definedOf = (input: LayerInput, keys: ReadonlyArray<string>) =>
  Object.fromEntries(
    Object.entries(input).filter(([key, value]) => keys.includes(key) && value !== undefined),
  );

const strayKey = (input: LayerInput, kind: CarouselLayer["kind"]) => {
  const keys = kind === "photo" ? PHOTO_KEYS : TEXT_KEYS;
  const stray = Object.entries(input).find(
    ([key, value]) => key !== "kind" && value !== undefined && !keys.includes(key),
  );
  return stray === undefined ? null : `a ${kind} layer has no ${stray[0]}`;
};

const newLayer = (
  document: CarouselDocument,
  id: string,
  input: LayerInput,
): CarouselLayer | string => {
  const { width, height } = slideSize(document.ratio);
  if (input.kind === undefined) return "needs layer.kind (photo or text)";
  const stray = strayKey(input, input.kind);
  if (stray !== null) return stray;
  if (input.kind === "text") {
    if (input.text === undefined) return "needs layer.text";
    return {
      ...DEFAULT_TEXT,
      id,
      text: input.text,
      x: width / 2,
      y: height / 2,
      ...definedOf(input, TEXT_KEYS),
    };
  }
  if (input.src === undefined) return "needs layer.src";
  const photo = document.photos.find((other) => other.src === input.src);
  // A frame of the photo's own shape, unless the edit gives one.
  const frameWidth = input.width ?? 720;
  const shape = photo !== undefined && photo.width > 0 ? photo.height / photo.width : 1.25;
  return {
    kind: "photo",
    id,
    src: input.src,
    x: width / 2,
    y: height / 2,
    width: frameWidth,
    height: Math.round(frameWidth * shape),
    rotation: 0,
    opacity: 1,
    radius: 0,
    span: 1,
    ...definedOf(input, PHOTO_KEYS),
  };
};

const applyOne = (document: CarouselDocument, edit: CarouselEdit): CarouselDocument | string => {
  const slideIndex =
    edit.slide === undefined ? -1 : document.slides.findIndex((slide) => slide.id === edit.slide);
  const slide = document.slides[slideIndex];
  const needsSlide =
    edit.slide === undefined ? "needs slide" : `no slide ${edit.slide} in this carousel`;
  const withSlide = (next: CarouselSlide): CarouselDocument => ({
    ...document,
    slides: document.slides.map((other, index) => (index === slideIndex ? next : other)),
  });
  const { height } = slideSize(document.ratio);

  switch (edit.kind) {
    case "addSlide": {
      if (document.slides.length >= MAX_SLIDES) {
        return `Instagram takes at most ${MAX_SLIDES} slides in one post`;
      }
      const base = blankSlide(`s${document.nextId}`);
      let nextId = document.nextId + 1;
      let added = base;
      if (edit.layout === "photo") {
        if (edit.src === undefined) return "a photo slide needs src";
        const problem = photoProblem(document, edit.src);
        if (problem !== null) return problem;
        added = { ...base, background: { color: "#000000", photo: fullBleed(edit.src) } };
      } else if (edit.layout === "title") {
        added = {
          ...base,
          background: { color: "#f4efe6", photo: null },
          layers: [
            {
              ...DEFAULT_TEXT,
              id: `l${nextId}`,
              text: edit.text ?? "Title",
              size: 112,
              x: SLIDE_WIDTH / 2,
              y: height / 2,
            },
          ],
        };
        nextId += 1;
      }
      const slides = [...document.slides];
      slides.splice(clampIndex(edit.index, slides.length), 0, added);
      return { ...document, slides, nextId };
    }
    case "removeSlide":
      if (slide === undefined) return needsSlide;
      if (document.slides.length === 1) return "a carousel keeps at least one slide";
      return { ...document, slides: document.slides.filter((other) => other !== slide) };
    case "moveSlide":
      if (slide === undefined) return needsSlide;
      if (edit.index === undefined) return "needs index";
      return { ...document, slides: moved(document.slides, slideIndex, Math.round(edit.index)) };
    case "duplicateSlide": {
      if (slide === undefined) return needsSlide;
      if (document.slides.length >= MAX_SLIDES) {
        return `Instagram takes at most ${MAX_SLIDES} slides in one post`;
      }
      let nextId = document.nextId;
      const copy: CarouselSlide = {
        ...slide,
        id: `s${nextId++}`,
        layers: slide.layers.map((layer) => ({ ...layer, id: `l${nextId++}` })),
      };
      const slides = [...document.slides];
      slides.splice(slideIndex + 1, 0, copy);
      return { ...document, slides, nextId };
    }
    case "setBackground": {
      if (slide === undefined) return needsSlide;
      if (edit.color === undefined && edit.photo === undefined) return "needs color or photo";
      const previous = slide.background.photo;
      const photo =
        edit.photo === undefined
          ? previous
          : edit.photo === null
            ? null
            : {
                // The same photo keeps how it was placed; another one starts full-bleed.
                ...(previous?.src === edit.photo.src ? previous : fullBleed(edit.photo.src)),
                ...Object.fromEntries(
                  Object.entries(edit.photo).filter(([, value]) => value !== undefined),
                ),
              };
      return withSlide({
        ...slide,
        background: { color: edit.color ?? slide.background.color, photo },
      });
    }
    case "addLayer": {
      if (slide === undefined) return needsSlide;
      if (edit.layer === undefined) return "needs layer";
      const layer = newLayer(document, `l${document.nextId}`, edit.layer);
      if (typeof layer === "string") return layer;
      const layers = [...slide.layers];
      layers.splice(clampIndex(edit.index, layers.length), 0, layer);
      return { ...withSlide({ ...slide, layers }), nextId: document.nextId + 1 };
    }
    case "updateLayer":
    case "removeLayer":
    case "moveLayer": {
      if (slide === undefined) return needsSlide;
      const layerIndex = slide.layers.findIndex((layer) => layer.id === edit.layerId);
      const layer = slide.layers[layerIndex];
      if (layer === undefined) {
        return edit.layerId === undefined
          ? "needs layerId"
          : `no layer ${edit.layerId} on ${slide.id}`;
      }
      if (edit.kind === "removeLayer") {
        return withSlide({ ...slide, layers: slide.layers.filter((other) => other !== layer) });
      }
      if (edit.kind === "moveLayer") {
        if (edit.index === undefined) return "needs index";
        return withSlide({
          ...slide,
          layers: moved(slide.layers, layerIndex, Math.round(edit.index)),
        });
      }
      if (edit.layer === undefined) return "needs layer";
      if (edit.layer.kind !== undefined && edit.layer.kind !== layer.kind) {
        return `${layer.id} is a ${layer.kind} layer; a layer's kind can't change`;
      }
      const stray = strayKey(edit.layer, layer.kind);
      if (stray !== null) return stray;
      const changed = {
        ...layer,
        ...definedOf(edit.layer, layer.kind === "photo" ? PHOTO_KEYS : TEXT_KEYS),
      } as CarouselLayer;
      return withSlide({
        ...slide,
        layers: slide.layers.map((other) => (other === layer ? changed : other)),
      });
    }
    case "setCaption":
      return edit.text === undefined ? "needs text" : { ...document, caption: edit.text };
    case "setAltText":
      if (slide === undefined) return needsSlide;
      return edit.text === undefined ? "needs text" : withSlide({ ...slide, altText: edit.text });
    case "setRatio": {
      if (edit.ratio === undefined) return "needs ratio";
      // Things keep their place down the slide: a title a third of the way down stays there.
      const factor = slideSize(edit.ratio).height / height;
      return {
        ...document,
        ratio: edit.ratio,
        slides: document.slides.map((other) => ({
          ...other,
          background: {
            ...other.background,
            photo:
              other.background.photo === null
                ? null
                : { ...other.background.photo, offsetY: other.background.photo.offsetY * factor },
          },
          layers: other.layers.map((layer) => ({ ...layer, y: layer.y * factor })),
        })),
      };
    }
    case "restore": {
      if (edit.document === undefined) return "needs document";
      const known = new Set(document.photos.map((photo) => photo.src));
      return {
        ...document,
        ratio: edit.document.ratio,
        caption: edit.document.caption,
        slides: edit.document.slides,
        // Photos imported since stay; ids never go back, so a restored id is never reissued.
        photos: [
          ...document.photos,
          ...edit.document.photos.filter((photo) => !known.has(photo.src)),
        ],
        nextId: Math.max(document.nextId, edit.document.nextId),
      };
    }
  }
};

export type CarouselEditResult =
  | { readonly ok: true; readonly document: CarouselDocument }
  | { readonly ok: false; readonly error: string };

/**
 * Applies edits in order. One bad edit refuses them all, and says which and why, so a document
 * is never left half-changed.
 */
export const applyCarouselEdits = (
  document: CarouselDocument,
  edits: ReadonlyArray<CarouselEdit>,
): CarouselEditResult => {
  let current = document;
  for (const [index, edit] of edits.entries()) {
    const next = applyOne(current, edit);
    const problem = typeof next === "string" ? next : carouselProblem(next);
    if (typeof next === "string" || problem !== null) {
      return { ok: false, error: `Edit ${index + 1} (${edit.kind}): ${problem}.` };
    }
    current = next;
  }
  return { ok: true, document: current };
};

const quoted = (text: string, limit = 80) =>
  JSON.stringify(text.length > limit ? `${text.slice(0, limit)}…` : text);

const round = (value: number) => String(Math.round(value));

const layerLine = (layer: CarouselLayer) =>
  layer.kind === "photo"
    ? `  ${layer.id} photo ${layer.src} at ${round(layer.x)},${round(layer.y)} ${round(layer.width)}x${round(layer.height)}${layer.rotation === 0 ? "" : ` rot ${round(layer.rotation)}`}${layer.span > 1 ? ` span ${layer.span}` : ""}`
    : `  ${layer.id} text ${quoted(layer.text)} ${layer.font} ${round(layer.size)}/${layer.weight} ${layer.color} ${layer.align} at ${round(layer.x)},${round(layer.y)} maxWidth ${round(layer.maxWidth)}${layer.rotation === 0 ? "" : ` rot ${round(layer.rotation)}`}${layer.box === null ? "" : ` box ${layer.box.color}`}${layer.stroke === null ? "" : ` stroke ${layer.stroke.color}`}${layer.shadow === null ? "" : " shadow"}`;

/** One line per slide and per layer (bottom first), in the ids and pixels edits use. */
export const carouselText = (document: CarouselDocument): string => {
  const { width, height } = slideSize(document.ratio);
  return [
    `Carousel ${document.ratio}, each slide ${width}x${height}, ${document.slides.length} of ${MAX_SLIDES} slides, caption ${document.caption.length}/${MAX_CAPTION} characters`,
    ...document.slides.flatMap((slide, index) => {
      const { photo, color } = slide.background;
      const background =
        photo === null
          ? color
          : `${photo.src} ${photo.fit}${photo.scale === 1 ? "" : ` x${photo.scale}`} on ${color}`;
      return [
        `${index + 1}. ${slide.id} background ${background}${slide.altText === "" ? " (no alt text)" : ` alt ${quoted(slide.altText, 60)}`}`,
        ...slide.layers.map(layerLine),
      ];
    }),
    document.photos.length === 0
      ? "Photos: none imported"
      : `Photos: ${document.photos.map((photo) => `${photo.src}${photo.width > 0 ? ` ${photo.width}x${photo.height}` : ""}`).join(", ")}`,
  ].join("\n");
};

/** A rectangle by its centre, turned `rotation` degrees clockwise about it. */
export interface Box extends Size {
  readonly cx: number;
  readonly cy: number;
  readonly rotation: number;
}

/** Where a background photo is drawn on its slide. */
export const placeBackgroundPhoto = (
  placement: CarouselPhotoPlacement,
  slide: Size,
  photo: Size,
): Box => {
  const across = slide.width / photo.width;
  const down = slide.height / photo.height;
  const scale =
    (placement.fit === "fill" ? Math.max(across, down) : Math.min(across, down)) * placement.scale;
  return {
    cx: slide.width / 2 + placement.offsetX,
    cy: slide.height / 2 + placement.offsetY,
    width: photo.width * scale,
    height: photo.height * scale,
    rotation: placement.rotation,
  };
};

/** The part of a photo that fills a frame, cut from the photo's centre. */
export const coverCrop = (frame: Size, photo: Size): Rect => {
  const scale = Math.max(frame.width / photo.width, frame.height / photo.height);
  const width = frame.width / scale;
  const height = frame.height / scale;
  return { x: (photo.width - width) / 2, y: (photo.height - height) / 2, width, height };
};

export type MeasureText = (text: string) => number;

/** Breaks text at spaces to fit a width; a word wider than the line is broken by character. */
export const wrapText = (text: string, maxWidth: number, measure: MeasureText): Array<string> => {
  const lines: Array<string> = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter((part) => part !== "")) {
      const joined = line === "" ? word : `${line} ${word}`;
      if (measure(joined) <= maxWidth) {
        line = joined;
        continue;
      }
      if (line !== "") lines.push(line);
      line = word;
      while (measure(line) > maxWidth && line.length > 1) {
        let fits = 1;
        while (fits < line.length - 1 && measure(line.slice(0, fits + 1)) <= maxWidth) fits += 1;
        lines.push(line.slice(0, fits));
        line = line.slice(fits);
      }
    }
    lines.push(line);
  }
  return lines;
};

export interface TextBlock extends Size {
  /** Each line's left edge and vertical middle, from the block's centre. */
  readonly lines: ReadonlyArray<{
    readonly text: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
  }>;
  /** The filled box behind the words, from the block's centre, when the layer has one. */
  readonly box: Rect | null;
}

/**
 * A text layer's lines and box, in pixels from the block's centre. The block is `maxWidth`
 * wide whatever the words measure, so its centre doesn't move as the text is typed.
 */
export const layoutText = (layer: CarouselTextLayer, measure: MeasureText): TextBlock => {
  const leading = layer.size * layer.lineHeight;
  const wrapped = wrapText(layer.text, layer.maxWidth, measure);
  const height = wrapped.length * leading;
  const lines = wrapped.map((text, index) => {
    const width = measure(text);
    return {
      text,
      width,
      x:
        layer.align === "left"
          ? -layer.maxWidth / 2
          : layer.align === "right"
            ? layer.maxWidth / 2 - width
            : -width / 2,
      y: -height / 2 + (index + 0.5) * leading,
    };
  });
  const widest = Math.max(0, ...lines.map((line) => line.width));
  const left = Math.min(...lines.map((line) => line.x));
  const inked = lines.some((line) => line.width > 0);
  const box =
    layer.box === null || !inked
      ? null
      : {
          x: left - layer.box.padding,
          y: -height / 2 - layer.box.padding,
          width: widest + layer.box.padding * 2,
          height: height + layer.box.padding * 2,
        };
  return { width: layer.maxWidth, height, lines, box };
};

/** The layer's outline on the slide: what a click hits and the selection frame hugs. */
export const layerBox = (
  layer: CarouselLayer,
  measure: (layer: CarouselTextLayer) => MeasureText,
): Box =>
  layer.kind === "photo"
    ? {
        cx: layer.x,
        cy: layer.y,
        width: layer.width,
        height: layer.height,
        rotation: layer.rotation,
      }
    : {
        cx: layer.x,
        cy: layer.y,
        width: layer.maxWidth,
        height: Math.max(layer.size, layoutText(layer, measure(layer)).height),
        rotation: layer.rotation,
      };

/** A slide point in a box's own axes, from its centre. */
export const toBoxSpace = (box: Box, point: { readonly x: number; readonly y: number }) => {
  const angle = (-box.rotation * Math.PI) / 180;
  const dx = point.x - box.cx;
  const dy = point.y - box.cy;
  return {
    x: dx * Math.cos(angle) - dy * Math.sin(angle),
    y: dx * Math.sin(angle) + dy * Math.cos(angle),
  };
};

export const boxContains = (box: Box, point: { readonly x: number; readonly y: number }) => {
  const local = toBoxSpace(box, point);
  return Math.abs(local.x) <= box.width / 2 && Math.abs(local.y) <= box.height / 2;
};

/** The changes that scale a layer about its centre: a photo's frame, or a text's size and width. */
export const scaleLayer = (
  layer: CarouselLayer,
  factor: number,
): NonNullable<CarouselEdit["layer"]> =>
  layer.kind === "photo"
    ? {
        width: Math.max(8, Math.round(layer.width * factor)),
        height: Math.max(8, Math.round(layer.height * factor)),
      }
    : {
        size: Math.max(8, Math.min(800, Math.round(layer.size * factor))),
        maxWidth: Math.max(40, Math.round(layer.maxWidth * factor)),
      };

/**
 * What a slide draws above its background, bottom first: photo layers that run on from earlier
 * slides, shifted left by the slides they have crossed, then the slide's own layers.
 */
export const layersOnSlide = (
  document: CarouselDocument,
  index: number,
): Array<{ readonly layer: CarouselLayer; readonly offsetX: number }> => {
  const carried = document.slides
    .slice(0, index)
    .flatMap((slide, from) =>
      slide.layers
        .filter((layer) => layer.kind === "photo" && layer.span > index - from)
        .map((layer) => ({ layer, offsetX: -(index - from) * SLIDE_WIDTH })),
    );
  return [
    ...carried,
    ...(document.slides[index]?.layers ?? []).map((layer) => ({ layer, offsetX: 0 })),
  ];
};

/** The photos slide `index` draws: its background's, then those of the layers on it. */
export const slidePhotos = (document: CarouselDocument, index: number): Array<string> => {
  const background = document.slides[index]?.background.photo?.src;
  return [
    ...new Set([
      ...(background === undefined ? [] : [background]),
      ...layersOnSlide(document, index).flatMap(({ layer }) =>
        layer.kind === "photo" ? [layer.src] : [],
      ),
    ]),
  ];
};

/** How an export gets the pixels a photo shows in one place, resampling the original once. */
export type PhotoResample =
  /** Enlarged or shown pixel for pixel: the canvas draws the original as it is. */
  | { readonly kind: "direct" }
  /** No part of it is on the canvas. */
  | { readonly kind: "hidden" }
  /**
   * Reduced: each pixel of `target` is the average of the part of `window`, in the photo's
   * pixels, that lands on it. Upright, `target` is the canvas pixels covered; turned, it is
   * the drawn size alone and the canvas turns the result.
   */
  | {
      readonly kind: "average";
      readonly window: Rect;
      readonly target: Rect;
      readonly aligned: boolean;
    };

// Layout arithmetic leaves a size a hair off; this much more than 1:1 is still not a reduction.
const SCALE_SLACK = 1e-6;

/**
 * How the part `crop` of a photo lands on `drawn`, a rectangle in canvas pixels before any
 * turn. A canvas reduces by halving and blending the nearest sizes, which loses detail, so a
 * reduction is averaged from the original onto the pixels whose centre is inside `drawn`:
 * the ones a canvas fills, so an export's edges are the editor's and no seam opens.
 */
export const photoResample = (input: {
  readonly crop: Rect;
  readonly drawn: Rect;
  readonly turned: boolean;
  readonly canvas: Size;
}): PhotoResample => {
  const { crop, drawn, canvas } = input;
  if (!(drawn.width > 0 && drawn.height > 0 && crop.width > 0 && crop.height > 0)) {
    return { kind: "hidden" };
  }
  const across = crop.width / drawn.width;
  const down = crop.height / drawn.height;
  if (across <= 1 + SCALE_SLACK && down <= 1 + SCALE_SLACK) return { kind: "direct" };
  if (input.turned) {
    return {
      kind: "average",
      window: crop,
      target: {
        x: 0,
        y: 0,
        width: Math.max(1, Math.round(drawn.width)),
        height: Math.max(1, Math.round(drawn.height)),
      },
      aligned: false,
    };
  }
  const left = Math.max(0, Math.round(drawn.x));
  const top = Math.max(0, Math.round(drawn.y));
  const right = Math.min(canvas.width, Math.round(drawn.x + drawn.width));
  const bottom = Math.min(canvas.height, Math.round(drawn.y + drawn.height));
  if (right <= left || bottom <= top) return { kind: "hidden" };
  return {
    kind: "average",
    window: {
      x: crop.x + (left - drawn.x) * across,
      y: crop.y + (top - drawn.y) * down,
      width: (right - left) * across,
      height: (bottom - top) * down,
    },
    target: { x: left, y: top, width: right - left, height: bottom - top },
    aligned: true,
  };
};

/** High enough that Instagram's own recompression is the only visible one. */
export const EXPORT_JPEG_QUALITY = 0.95;

const EXTENSIONS: Record<CarouselImageFormat, string> = { jpeg: "jpg", png: "png" };

/** `01.jpg`, `02.jpg`…: a file manager and Instagram's picker both list them in slide order. */
export const exportFileNames = (count: number, format: CarouselImageFormat): Array<string> =>
  Array.from(
    { length: count },
    (_, index) => `${String(index + 1).padStart(2, "0")}.${EXTENSIONS[format]}`,
  );

/** Files an earlier export left, which a shorter carousel must not leave beside its own. */
export const isExportFile = (name: string) => /^\d{2}\.(jpg|png)$/.test(name);

/** The caption and each slide's alt text, as the text file written beside an export. */
export const captionFileText = (document: CarouselDocument) =>
  [
    document.caption,
    "",
    "Alt text",
    ...document.slides.map(
      (slide, index) => `${index + 1}. ${slide.altText === "" ? "(none)" : slide.altText}`,
    ),
    "",
  ].join("\n");

/** What Instagram would refuse or quietly change, in words for the person about to post. */
export const exportWarnings = (document: CarouselDocument): Array<string> => {
  const hashtags = document.caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  const untitled = document.slides.filter((slide) => slide.altText === "").length;
  return [
    ...(document.slides.length < 2
      ? ["One slide posts as a single photo; a carousel needs at least two."]
      : []),
    ...(hashtags > MAX_HASHTAGS
      ? [`The caption has ${hashtags} hashtags; Instagram allows ${MAX_HASHTAGS}.`]
      : []),
    ...(untitled > 0 ? [`${untitled} of ${document.slides.length} slides have no alt text.`] : []),
  ];
};

/** Every slide on one picture, in reading order, for a look at the whole post at once. */
export const contactSheetLayout = (count: number, slide: Size, cellWidth: number) => {
  const gap = Math.round(cellWidth / 20);
  const columns = Math.max(1, Math.min(count, 5));
  const rows = Math.max(1, Math.ceil(count / columns));
  const cellHeight = Math.round((cellWidth * slide.height) / slide.width);
  return {
    width: columns * cellWidth + (columns + 1) * gap,
    height: rows * cellHeight + (rows + 1) * gap,
    cells: Array.from({ length: count }, (_, index): Rect => ({
      x: gap + (index % columns) * (cellWidth + gap),
      y: gap + Math.floor(index / columns) * (cellHeight + gap),
      width: cellWidth,
      height: cellHeight,
    })),
  };
};

/** The pixel size a PNG or JPEG file declares, or null when it is neither. */
export const imageSize = (
  bytes: Uint8Array,
): (Size & { readonly format: CarouselImageFormat }) | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 24 && view.getUint32(0) === 0x89504e47) {
    return { format: "png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let at = 2;
  while (at + 9 < bytes.byteLength) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    // SOF0 to SOF15 hold the size, except the three that are tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { format: "jpeg", width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
    }
    at += 2 + view.getUint16(at + 2);
  }
  return null;
};
