/**
 * Draws a theme's scene on a canvas, once. Layers are rasterised to tone buffers when the size or
 * scene changes; a draw composes them into three ink plates and prints those with the chosen
 * treatment. Nothing runs between draws: a draw follows a resize, a theme or setting change, or
 * the pointer crossing into the next parallax step.
 */
import type { BackdropTreatment } from "@t3tools/contracts/settings";

import { observeResize } from "~/lib/observeResize";

import { type Scene, sceneForTheme } from "./backdropScenes";

export type BackdropVariant = "hero" | "ambient" | "strip" | "preview";

export interface BackdropOptions {
  readonly variant: BackdropVariant;
  readonly treatment: BackdropTreatment;
  readonly values: Readonly<Record<string, number>>;
}

type Rgb = readonly [number, number, number];

interface ThemeInks {
  readonly themeId: string;
  readonly key: string;
  readonly inks: ReadonlyArray<Rgb>;
}

// The scene rows each variant shows. Behind a conversation the horizon sits lower, so messages
// read over sky; the sidebar strip is a slice across the horizon.
const VIEWS: Readonly<Record<BackdropVariant, readonly [number, number]>> = {
  hero: [0, 1],
  preview: [0, 1],
  ambient: [-0.3, 0.94],
  strip: [0.3, 0.8],
};
const SOURCE_DOT = 3;
// A small surface still gets enough rows to read as a picture.
const MIN_ROWS = 56;
const PARALLAX_PX = 12;
const RESIZE_SETTLE_MS = 140;
// Printed treatments work per output pixel; above this they print at half resolution.
const MAX_PRINT_PIXELS = 2_400_000;

const bayer8 = (() => {
  let matrix = [
    [0, 2],
    [3, 1],
  ];
  while (matrix.length < 8) {
    const size = matrix.length;
    const next: Array<Array<number>> = [];
    for (let y = 0; y < size * 2; y++) {
      const row: Array<number> = [];
      for (let x = 0; x < size * 2; x++) {
        const base = matrix[y % size]![x % size]! * 4;
        row.push(base + [0, 2, 3, 1][(y >= size ? 2 : 0) + (x >= size ? 1 : 0)]!);
      }
      next.push(row);
    }
    matrix = next;
  }
  return Float32Array.from(matrix.flat(), (value) => (value + 0.5) / 64);
})();

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

function toOklch([r, g, b]: Rgb): [number, number, number] {
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [lightness, Math.hypot(a, bb), Math.atan2(bb, a)];
}

function fromOklch(lightness: number, chroma: number, hue: number): Rgb {
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const gamma = (v: number) =>
    Math.round(255 * clamp01(v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  return [
    gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

let probe: CanvasRenderingContext2D | null | undefined;

/** Any CSS colour a theme can hold, as sRGB bytes. */
function readColor(value: string): Rgb | null {
  if (probe === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    probe = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!probe || value.trim().length === 0) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = value.trim();
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function readThemeInks(): ThemeInks {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const themeId = root.dataset.themeId ?? "";
  const paperValue = style.getPropertyValue("--app-theme-canvas");
  const accentValue = style.getPropertyValue("--app-theme-accent");
  const paper = toOklch(readColor(paperValue) ?? [0, 0, 0]);
  const accentRgb = readColor(accentValue) ?? [255, 255, 255];
  const accent = toOklch(accentRgb);
  const [midTurn, deepTurn] = sceneForTheme(themeId).hues;
  const turn = (degrees: number) => accent[2] + (degrees * Math.PI) / 180;
  const between = (share: number) => paper[0] + (accent[0] - paper[0]) * share;
  // Dots darker than the paper read far louder than lit dots on dark paper, so light themes print
  // every ink closer to the paper.
  const light = paper[0] > 0.6;
  return {
    themeId,
    key: `${themeId}|${paperValue}|${accentValue}`,
    inks: [
      light ? fromOklch(between(0.72), accent[1] * 0.8, accent[2]) : accentRgb,
      fromOklch(between(light ? 0.42 : 0.66), accent[1] * (light ? 0.7 : 0.95), turn(midTurn)),
      fromOklch(between(light ? 0.22 : 0.36), accent[1] * 0.6, turn(deepTurn)),
    ],
  };
}

const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;
let themeInks: ThemeInks | null = null;

/** The theme writes its colours to the root element's style; one observer serves every canvas. */
function subscribeThemeInks(listener: () => void): () => void {
  themeListeners.add(listener);
  if (themeObserver === null) {
    themeObserver = new MutationObserver(() => {
      const next = readThemeInks();
      if (next.key === themeInks?.key) return;
      themeInks = next;
      for (const notify of themeListeners) notify();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "data-theme-id"],
    });
  }
  return () => {
    themeListeners.delete(listener);
    if (themeListeners.size > 0) return;
    themeObserver?.disconnect();
    themeObserver = null;
    themeInks = null;
  };
}

const currentThemeInks = () => (themeInks ??= readThemeInks());

interface Raster {
  readonly key: string;
  readonly columns: number;
  readonly rows: number;
  readonly margin: number;
  readonly layers: ReadonlyArray<{
    readonly ink: number;
    readonly depth: number;
    readonly solid: boolean;
    readonly firstRow: number;
    readonly lastRow: number;
    readonly tones: Float32Array;
  }>;
}

// Hero and ambient swap as a thread starts, and threads remount the pane; keep the last few.
const rasterCache: Array<Raster> = [];

function rasterise(
  scene: Scene,
  key: string,
  columns: number,
  rows: number,
  margin: number,
  view: readonly [number, number],
): Raster {
  const cached = rasterCache.find((raster) => raster.key === key);
  if (cached) return cached;
  const span = view[1] - view[0];
  const dot = span / rows;
  const stride = columns + margin * 2;
  const layers = scene.layers({ aspect: columns * dot, dot }).map((layer) => {
    const tones = new Float32Array(stride * rows).fill(layer.solid ? -1 : 0);
    const firstRow = Math.max(0, Math.floor(((layer.band?.[0] ?? -9) - view[0]) / dot));
    const lastRow = Math.min(rows - 1, Math.ceil(((layer.band?.[1] ?? 9) - view[0]) / dot));
    for (let j = firstRow; j <= lastRow; j++) {
      const y = view[0] + (j + 0.5) * dot;
      for (let i = 0; i < stride; i++) {
        const column = i - margin;
        tones[j * stride + i] = layer.tone((column + 0.5 - columns / 2) * dot, y, column, j);
      }
    }
    return {
      ink: layer.ink,
      depth: layer.depth,
      solid: layer.solid === true,
      firstRow,
      lastRow,
      tones,
    };
  });
  const raster = { key, columns, rows, margin, layers };
  rasterCache.unshift(raster);
  rasterCache.length = Math.min(rasterCache.length, 4);
  return raster;
}

/** Front to back, each layer inks what the ones in front left uncovered. */
function compose(raster: Raster, pointer: number, contrast: number): Float32Array {
  const { columns, rows, margin, layers } = raster;
  const stride = columns + margin * 2;
  const plates = new Float32Array(columns * rows * 3);
  const shifts = layers.map((layer) => margin - Math.round(layer.depth * pointer * margin));
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      let open = 1;
      const at = (j * columns + i) * 3;
      for (let index = layers.length - 1; index >= 0 && open > 0.004; index--) {
        const layer = layers[index]!;
        if (j < layer.firstRow || j > layer.lastRow) continue;
        const raw = layer.tones[j * stride + i + shifts[index]!]!;
        if (raw < 0) continue;
        const tone = raw <= 0 ? 0 : clamp01((raw - 0.35) * contrast + 0.35);
        plates[at + layer.ink]! += open * tone;
        open = layer.solid ? 0 : open * (1 - tone);
      }
    }
  }
  return plates;
}

/** Vertical glass ribs: each bends what is behind it sideways and shades towards one edge. */
function flute(
  plates: Float32Array,
  columns: number,
  rows: number,
  rib: number,
  distortion: number,
): Float32Array {
  const out = new Float32Array(plates.length);
  for (let i = 0; i < columns; i++) {
    const across = (i % rib) / rib;
    const from = Math.min(
      columns - 1,
      Math.max(0, Math.round(i + (across - 0.5) * rib * distortion * 3)),
    );
    const shade = 1 - 0.5 * distortion * across * across;
    const edge = i % rib === 0 ? 0.06 + 0.14 * distortion : 0;
    for (let j = 0; j < rows; j++) {
      const to = (j * columns + i) * 3;
      const source = (j * columns + from) * 3;
      out[to] = plates[source]! * shade;
      out[to + 1] = plates[source + 1]! * shade;
      out[to + 2] = Math.min(1, plates[source + 2]! * shade + edge);
    }
  }
  return out;
}

function printDither(plates: Float32Array, columns: number, rows: number, inks: ThemeInks["inks"]) {
  const image = new ImageData(columns, rows);
  const pixels = image.data;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const at = (j * columns + i) * 3;
      const threshold = bayer8[(j & 7) * 8 + (i & 7)]!;
      const accent = plates[at]!;
      const mid = accent + plates[at + 1]!;
      const ink =
        threshold < accent ? 0 : threshold < mid ? 1 : threshold < mid + plates[at + 2]! ? 2 : -1;
      if (ink < 0) continue;
      const to = (j * columns + i) * 4;
      const color = inks[ink]!;
      pixels[to] = color[0];
      pixels[to + 1] = color[1];
      pixels[to + 2] = color[2];
      pixels[to + 3] = 255;
    }
  }
  return image;
}

interface Print {
  readonly plates: Float32Array;
  readonly columns: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  /** Source dots per output pixel. */
  readonly scale: number;
  readonly inks: ThemeInks["inks"];
}

/** Lays inks over each other, deep first, and writes the straight-alpha pixel. */
function writeInked(
  pixels: Uint8ClampedArray,
  to: number,
  inks: ThemeInks["inks"],
  a0: number,
  a1: number,
  a2: number,
) {
  let r = 0;
  let g = 0;
  let b = 0;
  let alpha = 0;
  const cover = [a2, a1, a0];
  for (let k = 0; k < 3; k++) {
    const share = cover[k]!;
    if (share <= 0) continue;
    const color = inks[2 - k]!;
    r = r * (1 - share) + color[0] * share;
    g = g * (1 - share) + color[1] * share;
    b = b * (1 - share) + color[2] * share;
    alpha = alpha * (1 - share) + share;
  }
  if (alpha <= 0) return;
  pixels[to] = r / alpha;
  pixels[to + 1] = g / alpha;
  pixels[to + 2] = b / alpha;
  pixels[to + 3] = alpha * 255;
}

/** One round dot per screen cell, sized by the tone at the cell's centre. */
function screenDot(
  print: Print,
  x: number,
  y: number,
  cell: number,
  cos: number,
  sin: number,
  plate: number,
): number {
  const u = (x * cos + y * sin) / cell;
  const v = (-x * sin + y * cos) / cell;
  const centreU = Math.floor(u) + 0.5;
  const centreV = Math.floor(v) + 0.5;
  const sourceI = Math.floor((centreU * cos - centreV * sin) * cell * print.scale);
  const sourceJ = Math.floor((centreU * sin + centreV * cos) * cell * print.scale);
  if (sourceI < 0 || sourceJ < 0 || sourceI >= print.columns || sourceJ >= print.rows) return 0;
  const at = (sourceJ * print.columns + sourceI) * 3;
  // A process plate also carries a share of its neighbours, as a separation would, so the
  // screens overlap and their angles show.
  const tone =
    plate < 0
      ? Math.min(1, print.plates[at]! + print.plates[at + 1]! + print.plates[at + 2]!)
      : Math.min(
          1,
          print.plates[at + plate]! +
            0.45 * print.plates[at + ((plate + 1) % 3)]! +
            0.3 * print.plates[at + ((plate + 2) % 3)]!,
        );
  if (tone <= 0.01) return 0;
  const distance = Math.hypot(u - centreU, v - centreV) * cell;
  const cover = clamp01(cell * 0.74 * Math.sqrt(tone) - distance + 0.5);
  // Which ink the dot is rides along in the integer part.
  if (plate >= 0 || cover <= 0) return cover;
  const a0 = print.plates[at]!;
  const a1 = print.plates[at + 1]!;
  const ink = a0 >= a1 && a0 >= print.plates[at + 2]! ? 0 : a1 >= print.plates[at + 2]! ? 1 : 2;
  return ink + Math.min(cover, 0.999);
}

function printHalftone(print: Print, cell: number, degrees: number) {
  const image = new ImageData(print.width, print.height);
  const cos = Math.cos((degrees * Math.PI) / 180);
  const sin = Math.sin((degrees * Math.PI) / 180);
  for (let y = 0; y < print.height; y++) {
    for (let x = 0; x < print.width; x++) {
      const dot = screenDot(print, x, y, cell, cos, sin, -1);
      if (dot <= 0) continue;
      const ink = Math.floor(dot);
      const cover = dot - ink;
      writeInked(
        image.data,
        (y * print.width + x) * 4,
        print.inks,
        ink === 0 ? cover : 0,
        ink === 1 ? cover : 0,
        ink === 2 ? cover : 0,
      );
    }
  }
  return image;
}

// Each ink has its own screen angle, as process plates do, so overlaps make rosettes.
const PLATE_ANGLES = [75, 15, 45].map((degrees) => {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)] as const;
});

function printProcess(print: Print, cell: number, offset: number) {
  const image = new ImageData(print.width, print.height);
  const cover = [0, 0, 0];
  for (let y = 0; y < print.height; y++) {
    for (let x = 0; x < print.width; x++) {
      for (let plate = 0; plate < 3; plate++) {
        const [cos, sin] = PLATE_ANGLES[plate]!;
        const slip = (plate - 1) * offset;
        cover[plate] = 0.85 * screenDot(print, x + slip, y + slip * 0.6, cell, cos, sin, plate);
      }
      writeInked(
        image.data,
        (y * print.width + x) * 4,
        print.inks,
        cover[0]!,
        cover[1]!,
        cover[2]!,
      );
    }
  }
  return image;
}

function grainAt(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Continuous tone on a toothy sheet: grain breaks the ink up, fibres run across it. */
function printPaper(print: Print, grain: number, fibre: number) {
  const image = new ImageData(print.width, print.height);
  const { plates, columns, rows } = print;
  for (let y = 0; y < print.height; y++) {
    const sourceY = Math.min(rows - 1.001, Math.max(0, (y + 0.5) * print.scale - 0.5));
    const j = Math.floor(sourceY);
    const fy = sourceY - j;
    for (let x = 0; x < print.width; x++) {
      const sourceX = Math.min(columns - 1.001, Math.max(0, (x + 0.5) * print.scale - 0.5));
      const i = Math.floor(sourceX);
      const fx = sourceX - i;
      const at = (j * columns + i) * 3;
      const below = at + columns * 3;
      const tooth = grainAt(x, y, 71);
      // Fibres are a few pixels long and one tall.
      const strand = grainAt(x >> 3, y, 72) * 0.6 + grainAt(x >> 1, y >> 1, 73) * 0.4;
      const take = 1 + grain * (tooth - 0.5) * 1.7 - fibre * 0.5 * strand;
      const sample = (plate: number) =>
        clamp01(
          ((plates[at + plate]! * (1 - fx) + plates[at + 3 + plate]! * fx) * (1 - fy) +
            (plates[below + plate]! * (1 - fx) + plates[below + 3 + plate]! * fx) * fy) *
            take,
        );
      const sheet = fibre * 0.16 * strand * strand;
      writeInked(
        image.data,
        (y * print.width + x) * 4,
        print.inks,
        sample(0),
        sample(1),
        clamp01(sample(2) + sheet),
      );
    }
  }
  return image;
}

/** Draws `options` on the canvas and keeps it current; returns the way to stop. */
export function mountBackdrop(canvas: HTMLCanvasElement, options: BackdropOptions): () => void {
  const context = canvas.getContext("2d");
  if (context === null) return () => undefined;

  let width = 0;
  let height = 0;
  let pointer = 0;
  let settle = 0;

  const draw = () => {
    if (width < 8 || height < 8 || options.treatment === "none") return;
    const theme = currentThemeInks();
    const { treatment, values, variant } = options;
    // The Settings preview is the scene in miniature, so its print scales down with it.
    const miniature = variant === "preview" ? Math.min(1, height / 640) : 1;
    const dithered = treatment === "dither" || treatment === "fluted";
    const dot = Math.max(
      1,
      Math.min(
        dithered ? (values.dotSize ?? SOURCE_DOT) * miniature : SOURCE_DOT,
        height / MIN_ROWS,
      ),
    );
    const columns = Math.max(1, Math.round(width / dot));
    const rows = Math.max(1, Math.round(height / dot));
    const margin = variant === "hero" ? Math.ceil(PARALLAX_PX / dot) : 0;
    const raster = rasterise(
      sceneForTheme(theme.themeId),
      `${theme.themeId}|${variant}|${columns}x${rows}|${margin}`,
      columns,
      rows,
      margin,
      VIEWS[variant],
    );
    let plates = compose(raster, pointer, values.contrast ?? 1);
    if (treatment === "fluted") {
      const rib = Math.max(3, Math.round(((values.ribSize ?? 36) * miniature) / dot));
      plates = flute(plates, columns, rows, rib, values.distortion ?? 0.5);
    }
    let image: ImageData;
    if (dithered) {
      image = printDither(plates, columns, rows, theme.inks);
    } else {
      // Three screens per pixel make the process print the dearest, so it always prints at half.
      const step = treatment !== "halftone" || width * height > MAX_PRINT_PIXELS ? 2 : 1;
      const print: Print = {
        plates,
        columns,
        rows,
        width: Math.ceil(width / step),
        height: Math.ceil(height / step),
        scale: step / dot,
        inks: theme.inks,
      };
      image =
        treatment === "halftone"
          ? printHalftone(print, ((values.dotSize ?? 8) * miniature) / step, values.angle ?? 30)
          : treatment === "cmyk"
            ? printProcess(
                print,
                ((values.dotSize ?? 7) * miniature) / step,
                ((values.offset ?? 2) * miniature) / step,
              )
            : printPaper(print, values.grain ?? 0.5, values.fibre ?? 0.4);
    }
    if (canvas.width !== image.width) canvas.width = image.width;
    if (canvas.height !== image.height) canvas.height = image.height;
    canvas.style.imageRendering = treatment === "paper" ? "auto" : "pixelated";
    context.putImageData(image, 0, 0);
  };

  const stopObservingSize = observeResize(canvas, (entries) => {
    const box = entries[0]?.contentRect;
    if (!box) return;
    const first = width === 0;
    width = Math.round(box.width);
    height = Math.round(box.height);
    window.clearTimeout(settle);
    // The canvas stretches with its box meanwhile; the picture is redrawn once the drag rests.
    settle = window.setTimeout(draw, first ? 0 : RESIZE_SETTLE_MS);
  });
  const unsubscribeTheme = subscribeThemeInks(draw);

  // Layers slide a few dots as the pointer crosses the window; a draw happens only when the
  // pointer enters the next dot-wide step, so a still or absent pointer costs nothing.
  const stillness = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onPointerMove = (event: PointerEvent) => {
    const treatment = options.treatment;
    if (stillness.matches || (treatment !== "dither" && treatment !== "fluted")) return;
    const steps = Math.ceil(PARALLAX_PX / SOURCE_DOT);
    const next = Math.round(((event.clientX / window.innerWidth) * 2 - 1) * steps) / steps;
    if (next === pointer) return;
    pointer = next;
    draw();
  };
  if (options.variant === "hero") {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
  }

  return () => {
    window.clearTimeout(settle);
    stopObservingSize();
    unsubscribeTheme();
    window.removeEventListener("pointermove", onPointerMove);
  };
}
