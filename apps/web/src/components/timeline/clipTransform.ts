import type { LaidOutClip } from "@t3tools/timeline/layout";
import { TIMELINE_NAMESPACE } from "@t3tools/timeline/otio";
import type { TextStyle } from "@t3tools/timeline/premiere/textStyle";
import { sourceSecondsAt } from "@t3tools/timeline/speed";

type Value = number | ReadonlyArray<number>;

/** How a keyframe leaves for the next one: held, or a cubic bezier as CSS writes it. */
export type Easing = "hold" | readonly [number, number, number, number];
type Keyframe = readonly [number, Value] | readonly [number, Value, Easing];

export interface ClipTransform {
  readonly position?: ReadonlyArray<number>;
  readonly scale?: number;
  readonly rotation?: number;
  readonly opacity?: number;
  readonly gain_db?: number;
  /** Percent of the picture taken off each edge, as Premiere's Crop. */
  readonly crop_left?: number;
  readonly crop_top?: number;
  readonly crop_right?: number;
  readonly crop_bottom?: number;
  readonly keyframes?: Readonly<Record<string, ReadonlyArray<Keyframe>>>;
}

const NO_TRANSFORM: ClipTransform = {};

export const transformOf = (item: LaidOutClip): ClipTransform =>
  (item.clip.metadata[TIMELINE_NAMESPACE] as { transform?: ClipTransform } | undefined)
    ?.transform ?? NO_TRANSFORM;

interface GraphicMetadata {
  readonly text?: string;
  readonly textPosition?: ReadonlyArray<number>;
  readonly textStyle?: TextStyle;
  readonly caption?: boolean;
  readonly blendMode?: string;
  readonly effects?: ReadonlyArray<{ kind: string; label: string; matchName?: string }>;
}

const NO_GRAPHIC: GraphicMetadata = {};

export const graphicOf = (item: LaidOutClip): GraphicMetadata =>
  (item.clip.metadata[TIMELINE_NAMESPACE] as GraphicMetadata | undefined) ?? NO_GRAPHIC;

/** The words of a text graphic; older pulls only have them as the Text effect's label. */
export const graphicText = (item: LaidOutClip): string => {
  const graphic = graphicOf(item);
  if (graphic.text !== undefined) return graphic.text;
  return graphic.effects?.find((e) => e.kind === "Text" && e.label !== e.kind)?.label ?? "";
};

/** Where the text layer's anchor sits, as a fraction of the frame. */
export const graphicTextPosition = (item: LaidOutClip): readonly [number, number] | null => {
  const [x, y] = graphicOf(item).textPosition ?? [];
  return x === undefined || y === undefined ? null : [x, y];
};

/**
 * A CSS cubic-bezier's value at `x`: the curve runs (0,0) to (1,1) with control points
 * (x1,y1) and (x2,y2). Solved by bisection on the curve's own parameter, which always converges.
 */
export const cubicBezier = (x1: number, y1: number, x2: number, y2: number, x: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const at = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t;
  let low = 0;
  let high = 1;
  let t = x;
  for (let step = 0; step < 24; step++) {
    const guess = at(x1, x2, t);
    if (Math.abs(guess - x) < 1e-5) break;
    if (guess < x) low = t;
    else high = t;
    t = (low + high) / 2;
  }
  return at(y1, y2, t);
};

/** One number of a keyframed (or static) param at `seconds`; `index` picks x or y of a point. */
const numberAt = (
  transform: ClipTransform,
  key: string,
  index: number,
  seconds: number,
  fallback: number,
): number => {
  const pick = (value: Value | undefined) =>
    value === undefined ? fallback : typeof value === "number" ? value : (value[index] ?? fallback);
  const points = transform.keyframes?.[key];
  if (points === undefined || points.length === 0) {
    return pick((transform as Record<string, Value | undefined>)[key]);
  }
  let after = 0;
  while (after < points.length && points[after]![0] <= seconds) after++;
  if (after === 0) return pick(points[0]![1]);
  const previous = points[after - 1]!;
  if (after === points.length) return pick(previous[1]);
  const next = points[after]!;
  const easing = previous[2];
  if (easing === "hold") return pick(previous[1]);
  const span = next[0] - previous[0];
  const linear = span === 0 ? 1 : (seconds - previous[0]) / span;
  const k =
    easing === undefined ? linear : cubicBezier(easing[0], easing[1], easing[2], easing[3], linear);
  const from = pick(previous[1]);
  return from + (pick(next[1]) - from) * k;
};

export interface ClipPose {
  /** Anchor position as a fraction of the frame. */
  x: number;
  y: number;
  /** 1 is the media's own pixel size, as Premiere's Scale 100. */
  scale: number;
  rotation: number;
  opacity: number;
  gainDb: number;
  /** Fractions of the picture cropped off each edge. */
  cropLeft: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
}

export const emptyPose = (): ClipPose => ({
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
  opacity: 1,
  gainDb: 0,
  cropLeft: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0,
});

const fraction = (percent: number) => Math.min(1, Math.max(0, percent / 100));

/** The clip's pose `seconds` in. Pass `into` to reuse an object, as the engine does every frame. */
export const poseAt = (
  transform: ClipTransform,
  seconds: number,
  into: ClipPose = emptyPose(),
): ClipPose => {
  into.x = numberAt(transform, "position", 0, seconds, 0.5);
  into.y = numberAt(transform, "position", 1, seconds, 0.5);
  into.scale = numberAt(transform, "scale", 0, seconds, 100) / 100;
  into.rotation = numberAt(transform, "rotation", 0, seconds, 0);
  into.opacity = numberAt(transform, "opacity", 0, seconds, 100) / 100;
  into.gainDb = numberAt(transform, "gain_db", 0, seconds, 0);
  into.cropLeft = fraction(numberAt(transform, "crop_left", 0, seconds, 0));
  into.cropTop = fraction(numberAt(transform, "crop_top", 0, seconds, 0));
  into.cropRight = fraction(numberAt(transform, "crop_right", 0, seconds, 0));
  into.cropBottom = fraction(numberAt(transform, "crop_bottom", 0, seconds, 0));
  return into;
};

/** The level alone, for audio, which has no use for the rest of a pose. */
export const gainDbAt = (transform: ClipTransform, seconds: number): number =>
  numberAt(transform, "gain_db", 0, seconds, 0);

/** Seconds into the clip at a timeline frame, clamped to the clip. */
export const clipOffset = (item: LaidOutClip, rate: number, frame: number): number => {
  const { duration } = item.clip.source_range;
  return Math.min(Math.max(0, (frame - item.startFrame) / rate), duration.value / duration.rate);
};

/**
 * Source seconds a clip shows at a timeline frame, following its speed and direction. Not
 * clamped to the clip: a transition plays it before its start and past its end.
 */
export const clipSourceAt = (item: LaidOutClip, rate: number, frame: number): number =>
  Math.max(0, sourceSecondsAt(item.clip, (frame - item.startFrame) / rate));

/** Seconds into the clip and into its source media at a timeline frame, clamped to the clip. */
export const clipTimes = (item: LaidOutClip, rate: number, frame: number) => {
  const { duration } = item.clip.source_range;
  const length = duration.value / duration.rate;
  const offset = clipOffset(item, rate, frame);
  return { offset, source: sourceSecondsAt(item.clip, offset), length };
};

const WEIGHTS: ReadonlyArray<readonly [RegExp, number]> = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/semi ?bold|demi/i, 600],
  [/extra ?bold|ultra ?bold|heavy/i, 800],
  [/black/i, 900],
  [/bold/i, 700],
  [/light/i, 300],
  [/medium/i, 500],
];

/**
 * The CSS font for a PostScript name, such as "BeVietnamPro-SemiBold": the family as it is
 * usually installed ("Be Vietnam Pro"), then the name as given, then the system's sans. A
 * browser without the font shows the fallback; nothing is downloaded.
 */
export const cssFontOf = (
  postscript: string | undefined,
): { readonly family: string; readonly weight: number; readonly italic: boolean } => {
  const fallback = "system-ui, sans-serif";
  if (postscript === undefined || postscript === "") {
    return { family: fallback, weight: 700, italic: false };
  }
  const [base = postscript, style = ""] = postscript.split("-");
  const plain = base.replace(/(PS)?MT$/, "");
  const spaced = plain.replace(/([a-z])([A-Z0-9])/g, "$1 $2");
  const weight = WEIGHTS.find(([pattern]) => pattern.test(style))?.[1] ?? 400;
  const names = [...new Set([spaced, plain, postscript])].map((name) => JSON.stringify(name));
  return {
    family: `${names.join(", ")}, ${fallback}`,
    weight,
    italic: /italic|oblique/i.test(style),
  };
};
