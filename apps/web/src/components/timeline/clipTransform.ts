import type { LaidOutClip } from "@t3tools/timeline/layout";
import { TIMELINE_NAMESPACE } from "@t3tools/timeline/otio";

type Value = number | ReadonlyArray<number>;

export interface ClipTransform {
  readonly position?: ReadonlyArray<number>;
  readonly scale?: number;
  readonly rotation?: number;
  readonly opacity?: number;
  readonly gain_db?: number;
  readonly keyframes?: Readonly<Record<string, ReadonlyArray<readonly [number, Value]>>>;
}

export const transformOf = (item: LaidOutClip): ClipTransform =>
  (item.clip.metadata[TIMELINE_NAMESPACE] as { transform?: ClipTransform } | undefined)
    ?.transform ?? {};

interface GraphicMetadata {
  readonly text?: string;
  readonly textPosition?: ReadonlyArray<number>;
  readonly effects?: ReadonlyArray<{ kind: string; label: string }>;
}

const graphicOf = (item: LaidOutClip) =>
  (item.clip.metadata[TIMELINE_NAMESPACE] as GraphicMetadata | undefined) ?? {};

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

/** Linear between keyframes; the native blob keeps Premiere's easing for the real render. */
const valueAt = (
  transform: ClipTransform,
  key: string,
  seconds: number,
  fallback: Value,
): Value => {
  const points = transform.keyframes?.[key];
  if (points === undefined || points.length === 0) {
    return (transform as Record<string, Value | undefined>)[key] ?? fallback;
  }
  const after = points.findIndex(([time]) => time > seconds);
  const first = points[0];
  const last = points.at(-1);
  if (after === 0 && first) return first[1];
  if (after === -1 && last) return last[1];
  const previous = points[after - 1];
  const next = points[after];
  if (previous === undefined || next === undefined) return fallback;
  const [t0, v0] = previous;
  const [t1, v1] = next;
  const k = t1 === t0 ? 1 : (seconds - t0) / (t1 - t0);
  const mix = (a: number, b: number) => a + (b - a) * k;
  if (typeof v0 === "number" || typeof v1 === "number") return mix(Number(v0), Number(v1));
  return v0.map((a, i) => mix(a, v1[i] ?? a));
};

const asNumber = (value: Value): number => (typeof value === "number" ? value : (value[0] ?? 0));

export interface ClipPose {
  /** Anchor position as a fraction of the frame. */
  readonly x: number;
  readonly y: number;
  /** 1 is the media's own pixel size, as Premiere's Scale 100. */
  readonly scale: number;
  readonly rotation: number;
  readonly opacity: number;
  readonly gainDb: number;
}

export const poseAt = (transform: ClipTransform, seconds: number): ClipPose => {
  const position = valueAt(transform, "position", seconds, [0.5, 0.5]);
  const [x, y] = typeof position === "number" ? [0.5, 0.5] : position;
  return {
    x: x ?? 0.5,
    y: y ?? 0.5,
    scale: asNumber(valueAt(transform, "scale", seconds, 100)) / 100,
    rotation: asNumber(valueAt(transform, "rotation", seconds, 0)),
    opacity: asNumber(valueAt(transform, "opacity", seconds, 100)) / 100,
    gainDb: asNumber(valueAt(transform, "gain_db", seconds, 0)),
  };
};

/** Seconds into the clip and into its source media at a timeline frame, clamped to the clip. */
export const clipTimes = (item: LaidOutClip, rate: number, frame: number) => {
  const { start_time, duration } = item.clip.source_range;
  const length = duration.value / duration.rate;
  const offset = Math.min(Math.max(0, (frame - item.startFrame) / rate), length);
  return { offset, source: start_time.value / start_time.rate + offset, length };
};
