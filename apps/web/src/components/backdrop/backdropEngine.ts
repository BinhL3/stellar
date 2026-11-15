/**
 * Draws a theme's scene on a canvas: layers rasterise to tone buffers per size, a draw composes
 * them into three ink plates and prints those. A full draw follows a resize, a setting change or
 * a parallax step; between them a clock tick re-inks only the dots that shimmers and sprites moved.
 */
import type { BackdropTreatment } from "@t3tools/contracts/settings";

import { observeResize } from "~/lib/observeResize";

import type { BackdropClock } from "./backdropClock";
import { backdropTreatmentMoves } from "./backdropTreatments";
import { type Scene, type SceneLayer, type Sprite, sceneForTheme } from "./backdropScenes";

export type BackdropVariant = "hero" | "ambient" | "strip" | "preview";

export interface BackdropOptions {
  readonly variant: BackdropVariant;
  readonly treatment: BackdropTreatment;
  readonly values: Readonly<Record<string, number>>;
  /** The pane whose picture this canvas continues: it draws the part of that pane's scene that
   * would fall where the canvas sits, on the same dot grid. */
  readonly stage?: HTMLElement;
  /** Animates the scene on this clock; without one the still picture is drawn. */
  readonly clock?: BackdropClock;
}

/** Where a canvas's dots sit in the picture of the pane it continues; its own picture by default. */
interface Frame {
  readonly columns: number;
  readonly rows: number;
  readonly stageColumns: number;
  readonly stageRows: number;
  readonly firstColumn: number;
  readonly firstRow: number;
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

interface RasterLayer {
  readonly ink: number;
  readonly depth: number;
  readonly solid: boolean;
  readonly firstRow: number;
  readonly lastRow: number;
  /** Still tones; a moving layer has none, its tones are stamped by each mount. */
  readonly tones: Float32Array | null;
  readonly tone: SceneLayer["tone"];
  readonly shimmer: NonNullable<SceneLayer["shimmer"]> | null;
  /** Indices of the dots the shimmer re-inks: those with a lit still tone. */
  readonly lit: Int32Array | null;
  readonly sprites: NonNullable<SceneLayer["sprites"]> | null;
}

interface Raster {
  readonly key: string;
  readonly frame: Frame;
  readonly margin: number;
  readonly stride: number;
  readonly dot: number;
  readonly top: number;
  readonly layers: ReadonlyArray<RasterLayer>;
}

// Hero and ambient swap as a thread starts, and threads remount the pane; keep the last few.
const rasterCache: Array<Raster> = [];

/** Scene coordinates of a raster dot, which tone functions take. */
const sceneX = (raster: Raster, column: number) =>
  (column + 0.5 - raster.frame.stageColumns / 2) * raster.dot;
const sceneY = (raster: Raster, row: number) => raster.top + (row + 0.5) * raster.dot;
/** Stage column of a raster index across a row, which includes the parallax margin. */
const stageColumn = (raster: Raster, index: number) =>
  raster.frame.firstColumn + index - raster.margin;

function rasterise(
  scene: Scene,
  key: string,
  frame: Frame,
  margin: number,
  view: readonly [number, number],
): Raster {
  const cached = rasterCache.find((raster) => raster.key === key);
  if (cached) return cached;
  const { columns, rows, stageColumns, stageRows, firstColumn, firstRow: rowOffset } = frame;
  const span = view[1] - view[0];
  const dot = span / stageRows;
  const stride = columns + margin * 2;
  const layers = scene.layers({ aspect: stageColumns * dot, dot }).map((layer): RasterLayer => {
    const bandRow = (edge: number) => (edge - view[0]) / dot - rowOffset;
    const firstRow = Math.max(0, Math.floor(bandRow(layer.band?.[0] ?? -9)));
    const lastRow = Math.min(rows - 1, Math.ceil(bandRow(layer.band?.[1] ?? 9)));
    const base = {
      ink: layer.ink,
      depth: layer.depth,
      solid: layer.solid === true,
      firstRow,
      lastRow,
      tone: layer.tone,
      shimmer: layer.shimmer ?? null,
      sprites: layer.sprites ?? null,
    };
    if (layer.sprites) return { ...base, tones: null, lit: null };
    const tones = new Float32Array(stride * rows).fill(layer.solid ? -1 : 0);
    const lit: Array<number> = [];
    for (let j = firstRow; j <= lastRow; j++) {
      const row = rowOffset + j;
      const y = view[0] + (row + 0.5) * dot;
      for (let i = 0; i < stride; i++) {
        const column = firstColumn + i - margin;
        const tone = layer.tone((column + 0.5 - stageColumns / 2) * dot, y, column, row, null);
        tones[j * stride + i] = tone;
        if (layer.shimmer && tone > 0) lit.push(j * stride + i);
      }
    }
    return { ...base, tones, lit: layer.shimmer ? Int32Array.from(lit) : null };
  });
  const raster = { key, frame, margin, stride, dot, top: view[0], layers };
  rasterCache.unshift(raster);
  rasterCache.length = Math.min(rasterCache.length, 4);
  return raster;
}

/** A canvas-dot rectangle, end-exclusive. */
interface Region {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * Front to back, each layer inks what the ones in front left uncovered. Writes `region` of
 * `plates`, or only its dots flagged in `only`, clearing their flags; `time` is the scene clock,
 * or null for the still picture.
 */
function compose(
  raster: Raster,
  buffers: ReadonlyArray<Float32Array>,
  shifts: ReadonlyArray<number>,
  contrast: number,
  time: number | null,
  plates: Float32Array,
  region: Region,
  only?: Uint8Array,
) {
  const { layers, stride } = raster;
  const { columns, firstRow: rowOffset } = raster.frame;
  for (let j = region.y0; j < region.y1; j++) {
    for (let i = region.x0; i < region.x1; i++) {
      if (only !== undefined) {
        if (only[j * columns + i] === 0) continue;
        only[j * columns + i] = 0;
      }
      let open = 1;
      const at = (j * columns + i) * 3;
      plates[at] = 0;
      plates[at + 1] = 0;
      plates[at + 2] = 0;
      for (let index = layers.length - 1; index >= 0 && open > 0.004; index--) {
        const layer = layers[index]!;
        if (j < layer.firstRow || j > layer.lastRow) continue;
        const column = i + shifts[index]!;
        let raw = buffers[index]![j * stride + column]!;
        if (raw < 0) continue;
        if (layer.shimmer !== null && raw > 0) {
          raw = layer.shimmer(raw, stageColumn(raster, column), rowOffset + j, time);
        }
        const tone = raw <= 0 ? 0 : clamp01((raw - 0.35) * contrast + 0.35);
        plates[at + layer.ink]! += open * tone;
        open = layer.solid ? 0 : open * (1 - tone);
      }
    }
  }
}

/** Vertical glass ribs: each bends what is behind it sideways and shades towards one edge. */
function flute(
  plates: Float32Array,
  out: Float32Array,
  columns: number,
  rib: number,
  distortion: number,
  region: Region,
) {
  for (let i = region.x0; i < region.x1; i++) {
    const across = (i % rib) / rib;
    const from = Math.min(
      columns - 1,
      Math.max(0, Math.round(i + (across - 0.5) * rib * distortion * 3)),
    );
    const shade = 1 - 0.5 * distortion * across * across;
    const edge = i % rib === 0 ? 0.06 + 0.14 * distortion : 0;
    for (let j = region.y0; j < region.y1; j++) {
      const to = (j * columns + i) * 3;
      const source = (j * columns + from) * 3;
      out[to] = plates[source]! * shade;
      out[to + 1] = plates[source + 1]! * shade;
      out[to + 2] = Math.min(1, plates[source + 2]! * shade + edge);
    }
  }
}

/** Blanks a region of the image before it is printed again. */
function clearRegion(image: ImageData, region: Region) {
  for (let y = region.y0; y < region.y1; y++) {
    image.data.fill(0, (y * image.width + region.x0) * 4, (y * image.width + region.x1) * 4);
  }
}

function printDither(
  plates: Float32Array,
  inks: ThemeInks["inks"],
  image: ImageData,
  region: Region,
) {
  const pixels = image.data;
  const columns = image.width;
  for (let j = region.y0; j < region.y1; j++) {
    for (let i = region.x0; i < region.x1; i++) {
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

function printHalftone(
  print: Print,
  cell: number,
  degrees: number,
  image: ImageData,
  region: Region,
) {
  const cos = Math.cos((degrees * Math.PI) / 180);
  const sin = Math.sin((degrees * Math.PI) / 180);
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
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
}

// Each ink has its own screen angle, as process plates do, so overlaps make rosettes.
const PLATE_ANGLES = [75, 15, 45].map((degrees) => {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)] as const;
});

function printProcess(
  print: Print,
  cell: number,
  offset: number,
  image: ImageData,
  region: Region,
) {
  const cover = [0, 0, 0];
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
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
}

function grainAt(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Continuous tone on a toothy sheet: grain breaks the ink up, fibres run across it. */
function printPaper(print: Print, grain: number, fibre: number, image: ImageData, region: Region) {
  const { plates, columns, rows } = print;
  for (let y = region.y0; y < region.y1; y++) {
    const sourceY = Math.min(rows - 1.001, Math.max(0, (y + 0.5) * print.scale - 0.5));
    const j = Math.floor(sourceY);
    const fy = sourceY - j;
    for (let x = region.x0; x < region.x1; x++) {
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
}

/** A moving layer's sprite boxes as raster rectangles, with the key that says how each looks. */
function spriteRects(raster: Raster, layer: RasterLayer, sprites: ReadonlyArray<Sprite>) {
  const { frame, dot, margin, stride, top } = raster;
  const rects: Array<number> = [];
  for (const sprite of sprites) {
    const index = (x: number) =>
      x / dot + frame.stageColumns / 2 - 0.5 - frame.firstColumn + margin;
    const row = (y: number) => (y - top) / dot - 0.5 - frame.firstRow;
    const x0 = Math.max(0, Math.floor(index(sprite.x0)) - 1);
    const x1 = Math.min(stride, Math.ceil(index(sprite.x1)) + 2);
    const y0 = Math.max(layer.firstRow, Math.floor(row(sprite.y0)) - 1);
    const y1 = Math.min(layer.lastRow + 1, Math.ceil(row(sprite.y1)) + 2);
    if (x0 >= x1 || y0 >= y1) continue;
    rects.push(x0, y0, x1, y1, sprite.key ?? 0);
  }
  return rects;
}

const sameRects = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

// Redraws gather into tiles of this many dots a side, then print row runs of them.
const TILE = 8;
// A tick checks every third lit dot for a shimmer's change; a twinkle lags a fraction of a second.
const SHIMMER_SHARE = 3;

/**
 * Draws `options` on the canvas and keeps it current; returns the way to stop. With a clock,
 * each tick re-inks only the dots its shimmers and sprites changed.
 */
export function mountBackdrop(canvas: HTMLCanvasElement, options: BackdropOptions): () => void {
  const context = canvas.getContext("2d");
  if (context === null) return () => undefined;

  let width = 0;
  let height = 0;
  let pointer = 0;
  let settle = 0;
  let time: number | null = options.clock ? options.clock.time() : null;

  // What the last full draw left, so a tick can repaint a part of it.
  interface Painted {
    readonly raster: Raster;
    readonly buffers: ReadonlyArray<Float32Array>;
    readonly shifts: ReadonlyArray<number>;
    readonly plates: Float32Array;
    readonly print: (region: Region) => void;
    /** The output pixels a change to these canvas dots can reach. */
    readonly reach: (region: Region) => Region;
    readonly image: ImageData;
    /** Per layer: the shimmer's last tone for each lit dot. */
    readonly shimmered: ReadonlyArray<Float32Array | null>;
    /** Per layer: the sprite rectangles last stamped. */
    readonly stamped: Array<ReadonlyArray<number>>;
    /** Dots a tick changed, and the tiles holding them, which print and upload together. */
    readonly changed: Uint8Array;
    readonly tiles: Uint8Array;
    readonly tileColumns: number;
    /** Ticks since this draw; shimmers are checked a share of their dots at a time. */
    ticks: number;
  }
  let painted: Painted | null = null;
  // A mount's own tones for its moving layers, kept while the raster stays the same.
  let liveFor: Raster | null = null;
  let live: Array<Float32Array | null> = [];

  /**
   * Inks a moving layer's new boxes and blanks what only its old ones covered, telling `changed`
   * about each dot whose tone actually moved, so a train's even flank is not printed again.
   */
  const restamp = (
    raster: Raster,
    index: number,
    before: ReadonlyArray<number>,
    rects: ReadonlyArray<number>,
    at: number | null,
    changed: (i: number, j: number) => void,
  ) => {
    const layer = raster.layers[index]!;
    const buffer = live[index]!;
    const { stride } = raster;
    for (let n = 0; n < rects.length; n += 5) {
      for (let j = rects[n + 1]!; j < rects[n + 3]!; j++) {
        const row = raster.frame.firstRow + j;
        const y = sceneY(raster, row);
        for (let i = rects[n]!; i < rects[n + 2]!; i++) {
          const column = stageColumn(raster, i);
          const tone = Math.fround(layer.tone(sceneX(raster, column), y, column, row, at));
          if (buffer[j * stride + i] === tone) continue;
          buffer[j * stride + i] = tone;
          changed(i, j);
        }
      }
    }
    const empty = layer.solid ? -1 : 0;
    const inNew = (i: number, j: number) => {
      for (let n = 0; n < rects.length; n += 5) {
        if (i >= rects[n]! && i < rects[n + 2]! && j >= rects[n + 1]! && j < rects[n + 3]!) {
          return true;
        }
      }
      return false;
    };
    for (let n = 0; n < before.length; n += 5) {
      for (let j = before[n + 1]!; j < before[n + 3]!; j++) {
        for (let i = before[n]!; i < before[n + 2]!; i++) {
          if (buffer[j * stride + i] === empty || inNew(i, j)) continue;
          buffer[j * stride + i] = empty;
          changed(i, j);
        }
      }
    }
  };

  const draw = () => {
    if (width < 8 || height < 8 || options.treatment === "none") return;
    const theme = currentThemeInks();
    const { treatment, values, variant } = options;
    // The Settings preview is the scene in miniature, so its print scales down with it.
    const miniature = variant === "preview" ? Math.min(1, height / 640) : 1;
    const dithered = treatment === "dither" || treatment === "fluted";
    const own = options.stage ? canvas.getBoundingClientRect() : null;
    const stageBox = options.stage?.getBoundingClientRect() ?? null;
    // The stage's picture has nothing above or below it, so a surface with no rows beside the
    // stage (a monitor docked under the chat) prints the scene in its own box instead.
    const stage =
      stageBox !== null && own !== null && own.bottom > stageBox.top && own.top < stageBox.bottom
        ? stageBox
        : null;
    const stageHeight = stage?.height ?? height;
    if (stage !== null && (stage.width < 8 || stage.height < 8)) return;
    const dot = Math.max(
      1,
      Math.min(
        dithered ? (values.dotSize ?? SOURCE_DOT) * miniature : SOURCE_DOT,
        stageHeight / MIN_ROWS,
      ),
    );
    const columns = Math.max(1, Math.round(width / dot));
    const rows = Math.max(1, Math.round(height / dot));
    const frame: Frame = {
      columns,
      rows,
      stageColumns: stage ? Math.max(1, Math.round(stage.width / dot)) : columns,
      stageRows: stage ? Math.max(1, Math.round(stage.height / dot)) : rows,
      firstColumn: stage && own ? Math.round((own.left - stage.left) / dot) : 0,
      firstRow: stage && own ? Math.round((own.top - stage.top) / dot) : 0,
    };
    const margin = variant === "hero" ? Math.ceil(PARALLAX_PX / dot) : 0;
    const raster = rasterise(
      sceneForTheme(theme.themeId),
      `${theme.themeId}|${variant}|${Object.values(frame).join(",")}|${margin}`,
      frame,
      margin,
      VIEWS[variant],
    );
    if (liveFor !== raster) {
      liveFor = raster;
      live = raster.layers.map((layer) =>
        layer.sprites ? new Float32Array(raster.stride * rows).fill(layer.solid ? -1 : 0) : null,
      );
    }
    const stamped = raster.layers.map((layer, index) => {
      if (layer.sprites === null) return [];
      live[index]!.fill(layer.solid ? -1 : 0);
      const rects = spriteRects(raster, layer, layer.sprites(time));
      restamp(raster, index, [], rects, time, () => undefined);
      return rects;
    });
    const shimmered = raster.layers.map((layer) => {
      const { lit, shimmer, tones } = layer;
      if (lit === null || shimmer === null || tones === null || time === null) return null;
      const now = time;
      return Float32Array.from(lit, (k) =>
        shimmer(
          tones[k]!,
          stageColumn(raster, k % raster.stride),
          frame.firstRow + Math.floor(k / raster.stride),
          now,
        ),
      );
    });
    const buffers = raster.layers.map((layer, index) => layer.tones ?? live[index]!);
    const shifts = raster.layers.map(
      (layer) => margin - Math.round(layer.depth * pointer * margin),
    );
    const contrast = values.contrast ?? 1;
    const whole: Region = { x0: 0, y0: 0, x1: columns, y1: rows };
    const plates = new Float32Array(columns * rows * 3);
    compose(raster, buffers, shifts, contrast, time, plates, whole);

    let image: ImageData;
    let print: (region: Region) => void;
    let reach: (region: Region) => Region;
    if (dithered) {
      image = new ImageData(columns, rows);
      if (treatment === "fluted") {
        const rib = Math.max(3, Math.round(((values.ribSize ?? 36) * miniature) / dot));
        const distortion = values.distortion ?? 0.5;
        const fluted = new Float32Array(plates.length);
        // A rib bends its source this many columns at most.
        const bend = Math.ceil(rib * distortion * 1.5) + 1;
        reach = (region) => ({
          ...region,
          x0: Math.max(0, region.x0 - bend),
          x1: Math.min(columns, region.x1 + bend),
        });
        print = (region) => {
          flute(plates, fluted, columns, rib, distortion, region);
          printDither(fluted, theme.inks, image, region);
        };
      } else {
        reach = (region) => region;
        print = (region) => printDither(plates, theme.inks, image, region);
      }
    } else {
      // Three screens per pixel make the process print the dearest, so it always prints at half.
      const step = treatment !== "halftone" || width * height > MAX_PRINT_PIXELS ? 2 : 1;
      const printing: Print = {
        plates,
        columns,
        rows,
        width: Math.ceil(width / step),
        height: Math.ceil(height / step),
        scale: step / dot,
        inks: theme.inks,
      };
      image = new ImageData(printing.width, printing.height);
      const cell = ((values.dotSize ?? (treatment === "halftone" ? 8 : 7)) * miniature) / step;
      const offset = ((values.offset ?? 2) * miniature) / step;
      // A screen cell reads the dot at its centre, so a change reaches about a cell around it.
      const pad = treatment === "paper" ? 2 : Math.ceil(cell * 1.5 + offset) + 2;
      const toPixels = dot / step;
      reach = (region) => ({
        x0: Math.max(0, Math.floor(region.x0 * toPixels) - pad),
        y0: Math.max(0, Math.floor(region.y0 * toPixels) - pad),
        x1: Math.min(printing.width, Math.ceil(region.x1 * toPixels) + pad),
        y1: Math.min(printing.height, Math.ceil(region.y1 * toPixels) + pad),
      });
      print =
        treatment === "halftone"
          ? (region) => printHalftone(printing, cell, values.angle ?? 30, image, region)
          : treatment === "cmyk"
            ? (region) => printProcess(printing, cell, offset, image, region)
            : (region) =>
                printPaper(printing, values.grain ?? 0.5, values.fibre ?? 0.4, image, region);
    }
    print(reach(whole));
    if (canvas.width !== image.width) canvas.width = image.width;
    if (canvas.height !== image.height) canvas.height = image.height;
    canvas.style.imageRendering = treatment === "paper" ? "auto" : "pixelated";
    context.putImageData(image, 0, 0);
    const tileColumns = Math.ceil(columns / TILE);
    painted = {
      raster,
      buffers,
      shifts,
      plates,
      print,
      reach,
      image,
      shimmered,
      stamped,
      changed: new Uint8Array(columns * rows),
      tiles: new Uint8Array(tileColumns * Math.ceil(rows / TILE)),
      tileColumns,
      ticks: 0,
    };
  };

  /** Moves the picture to the clock's `next` time, repainting only the tiles that changed. */
  const tick = (next: number) => {
    time = next;
    const state = painted;
    if (state === null) return;
    const { raster, shifts, tiles, tileColumns, changed } = state;
    const { columns, rows, firstRow } = raster.frame;
    const phase = state.ticks++ % SHIMMER_SHARE;
    let dirty = false;
    const mark = (i: number, j: number) => {
      if (i < 0 || i >= columns) return;
      changed[j * columns + i] = 1;
      tiles[Math.floor(j / TILE) * tileColumns + Math.floor(i / TILE)] = 1;
      dirty = true;
    };
    raster.layers.forEach((layer, index) => {
      const last = state.shimmered[index];
      if (layer.shimmer !== null && layer.lit !== null && layer.tones !== null && last) {
        const { lit, tones, shimmer } = layer;
        for (let n = phase; n < lit.length; n += SHIMMER_SHARE) {
          const k = lit[n]!;
          const across = k % raster.stride;
          const j = (k - across) / raster.stride;
          const tone = Math.fround(
            shimmer(tones[k]!, stageColumn(raster, across), firstRow + j, next),
          );
          if (tone === last[n]) continue;
          last[n] = tone;
          mark(across - shifts[index]!, j);
        }
      }
      if (layer.sprites !== null) {
        const before = state.stamped[index]!;
        const rects = spriteRects(raster, layer, layer.sprites(next));
        if (sameRects(before, rects)) return;
        const shift = shifts[index]!;
        restamp(raster, index, before, rects, next, (i, j) => mark(i - shift, j));
        state.stamped[index] = rects;
      }
    });
    if (!dirty) return;
    const contrast = options.values.contrast ?? 1;
    for (let ty = 0; ty * TILE < rows; ty++) {
      for (let tx = 0; tx < tileColumns; tx++) {
        if (tiles[ty * tileColumns + tx] === 0) continue;
        let end = tx;
        while (end < tileColumns && tiles[ty * tileColumns + end] === 1) {
          tiles[ty * tileColumns + end] = 0;
          end++;
        }
        const span: Region = {
          x0: tx * TILE,
          y0: ty * TILE,
          x1: Math.min(columns, end * TILE),
          y1: Math.min(rows, (ty + 1) * TILE),
        };
        const out = state.reach(span);
        compose(raster, state.buffers, shifts, contrast, next, state.plates, span, changed);
        clearRegion(state.image, out);
        state.print(out);
        context.putImageData(state.image, 0, 0, out.x0, out.y0, out.x1 - out.x0, out.y1 - out.y0);
        tx = end;
      }
    }
  };

  // The canvas stretches with its box meanwhile; the picture is redrawn once the drag rests.
  const redrawSettled = () => {
    window.clearTimeout(settle);
    settle = window.setTimeout(draw, RESIZE_SETTLE_MS);
  };
  const stopObservingSize = observeResize(canvas, (entries) => {
    const box = entries[0]?.contentRect;
    if (!box) return;
    const first = width === 0;
    width = Math.round(box.width);
    height = Math.round(box.height);
    if (!first) return redrawSettled();
    window.clearTimeout(settle);
    settle = window.setTimeout(draw, 0);
  });
  // The pane this canvas continues resizes with the window and with the sidebar's drag.
  let stageObserved = false;
  const stopObservingStage = options.stage
    ? observeResize(options.stage, () => {
        if (stageObserved) redrawSettled();
        stageObserved = true;
      })
    : () => undefined;
  const unsubscribeTheme = subscribeThemeInks(draw);
  const unsubscribeClock = options.clock?.subscribe(tick) ?? (() => undefined);

  // Layers slide a few dots as the pointer crosses the window; a draw happens only when the
  // pointer enters the next dot-wide step, so a still or absent pointer costs nothing.
  const stillness = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onPointerMove = (event: PointerEvent) => {
    if (stillness.matches || !backdropTreatmentMoves(options.treatment)) return;
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
    stopObservingStage();
    unsubscribeTheme();
    unsubscribeClock();
    window.removeEventListener("pointermove", onPointerMove);
  };
}
