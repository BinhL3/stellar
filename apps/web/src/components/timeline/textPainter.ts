import type { TextStyle } from "@t3tools/timeline/premiere/textStyle";

import { cssFontOf } from "./clipTransform";

/**
 * Draws a text graphic or caption with the look read from Premiere: each run's font, size,
 * fill and stroke, the layer's alignment, shadow and background box. A layout is built once
 * per clip; a frame only measures again when the size on screen or the loaded fonts change.
 */

interface Span {
  readonly text: string;
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
  /** Pixels of the sequence frame. */
  readonly size: number;
  readonly fill: string | null;
  readonly stroke: { readonly color: string; readonly width: number } | null;
  /** The canvas font and width at the size last drawn. */
  px: number;
  epoch: number;
  font: string;
  width: number;
}

interface Line {
  readonly spans: ReadonlyArray<Span>;
  readonly size: number;
}

export interface TextLayout {
  readonly lines: ReadonlyArray<Line>;
  readonly align: TextStyle["align"];
  readonly shadow: {
    readonly color: string;
    readonly dx: number;
    readonly dy: number;
    readonly blur: number;
  } | null;
  readonly background: {
    readonly color: string;
    readonly opacity: number;
    readonly padding: number;
  } | null;
}

const rgba = (hex: string, opacity: number) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${opacity})`;
};

const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Lines of styled spans for `words`. When the words were edited here they no longer match the
 * style's runs, so they all take the first run's look. `fallbackSize` is for runs that carry no
 * size, in frame pixels.
 */
export const layoutText = (style: TextStyle, words: string, fallbackSize: number): TextLayout => {
  const own = style.runs
    .map((run) => run.text)
    .join("")
    .replace(/\r$/, "");
  const first = style.runs[0];
  const runs = own === words || first === undefined ? style.runs : [{ ...first, text: words }];
  const layerScale = (style.scale ?? 100) / 100;
  const lines: Array<{ spans: Array<Span>; size: number }> = [{ spans: [], size: 0 }];
  for (const run of runs) {
    const font = cssFontOf(run.font);
    const size = (run.size ?? fallbackSize) * layerScale;
    run.text.split(LINE_BREAK).forEach((part, index) => {
      if (index > 0) lines.push({ spans: [], size: 0 });
      const line = lines.at(-1);
      if (line === undefined) return;
      // An empty line still takes its run's height.
      line.size = Math.max(line.size, size);
      if (part === "") return;
      line.spans.push({
        text: part,
        family: font.family,
        weight: font.weight,
        italic: font.italic,
        size,
        fill: run.fill === "none" ? null : (run.fill ?? "#ffffff"),
        stroke:
          run.stroke === undefined
            ? null
            : { color: run.stroke.color, width: run.stroke.width * layerScale },
        px: -1,
        epoch: -1,
        font: "",
        width: 0,
      });
    });
  }
  while (lines.length > 1 && lines.at(-1)?.spans.length === 0) lines.pop();
  const shadow = style.shadow;
  const angle = ((shadow?.angle ?? 135) * Math.PI) / 180;
  return {
    lines,
    align: style.align,
    shadow:
      shadow === undefined
        ? null
        : {
            color: rgba(shadow.color, shadow.opacity),
            // Premiere's 135° throws the shadow down and to the right.
            dx: Math.sin(angle) * shadow.distance * layerScale,
            dy: -Math.cos(angle) * shadow.distance * layerScale,
            blur: shadow.blur * layerScale,
          },
    background:
      style.background === undefined
        ? null
        : {
            color: style.background.color,
            opacity: style.background.opacity,
            padding: style.background.padding * layerScale,
          },
  };
};

const LEADING = 1.2;
// Captions sit centred this far above the bottom of the frame, Premiere's default zone.
const CAPTION_MARGIN = 0.1;

/**
 * Paints a layout with the context already at the clip's Motion position. `scale` turns frame
 * pixels into canvas pixels (the clip's Scale included). `anchor` is the text layer's position
 * as a fraction of the frame, the first line's baseline; without one the text is a caption.
 */
export const paintText = (
  context: CanvasRenderingContext2D,
  layout: TextLayout,
  input: {
    readonly scale: number;
    /** The frame's size on the canvas, at the clip's Scale. */
    readonly width: number;
    readonly height: number;
    readonly anchor: readonly [number, number] | null;
    readonly fontEpoch: number;
  },
) => {
  const { scale, width, height, anchor } = input;
  let block = 0;
  for (const line of layout.lines) {
    for (const span of line.spans) {
      const px = Math.max(1, Math.round(span.size * scale * 2) / 2);
      if (span.px !== px || span.epoch !== input.fontEpoch) {
        span.px = px;
        span.epoch = input.fontEpoch;
        span.font = `${span.italic ? "italic " : ""}${span.weight} ${px}px ${span.family}`;
        context.font = span.font;
        span.width = context.measureText(span.text).width;
      }
    }
    block += line.size * scale * LEADING;
  }
  const originX = anchor === null ? 0 : (anchor[0] - 0.5) * width;
  const last = layout.lines.at(-1);
  // A caption's last baseline sits on the margin; a text layer's first is its anchor.
  let baseline =
    anchor === null
      ? height / 2 -
        height * CAPTION_MARGIN -
        (block - (last === undefined ? 0 : last.size * scale * LEADING))
      : (anchor[1] - 0.5) * height;
  const align = anchor === null ? "center" : layout.align;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.lineJoin = "round";
  const opacity = context.globalAlpha;
  if (layout.background !== null) {
    // One box around every line, as wide as the widest.
    let widest = 0;
    for (const line of layout.lines) {
      let lineWidth = 0;
      for (const span of line.spans) lineWidth += span.width;
      widest = Math.max(widest, lineWidth);
    }
    const first = layout.lines[0];
    if (first !== undefined && widest > 0) {
      const pad = layout.background.padding * scale;
      const size = first.size * scale;
      const boxLeft =
        align === "center" ? originX - widest / 2 : align === "right" ? originX - widest : originX;
      context.globalAlpha = opacity * layout.background.opacity;
      context.fillStyle = layout.background.color;
      context.fillRect(
        boxLeft - pad - size * 0.15,
        baseline - size * 0.95 - pad,
        widest + 2 * pad + size * 0.3,
        block + 2 * pad,
      );
      context.globalAlpha = opacity;
    }
  }
  for (const line of layout.lines) {
    let lineWidth = 0;
    for (const span of line.spans) lineWidth += span.width;
    const left =
      align === "center"
        ? originX - lineWidth / 2
        : align === "right"
          ? originX - lineWidth
          : originX;
    const size = line.size * scale;
    let x = left;
    for (const span of line.spans) {
      context.font = span.font;
      // The shadow belongs to the first thing painted; the fill over a stroke casts none.
      if (layout.shadow !== null) {
        context.shadowColor = layout.shadow.color;
        context.shadowOffsetX = layout.shadow.dx * scale;
        context.shadowOffsetY = layout.shadow.dy * scale;
        context.shadowBlur = (layout.shadow.blur * scale) / 2;
      }
      if (span.stroke !== null) {
        context.strokeStyle = span.stroke.color;
        // The fill covers the inner half of an outline.
        context.lineWidth = span.stroke.width * scale * (span.fill === null ? 1 : 2);
        context.strokeText(span.text, x, baseline);
        context.shadowColor = "transparent";
      }
      if (span.fill !== null) {
        context.fillStyle = span.fill;
        context.fillText(span.text, x, baseline);
      }
      context.shadowColor = "transparent";
      x += span.width;
    }
    baseline += size * LEADING;
  }
  context.shadowBlur = 0;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
};
