/**
 * The agent-facing view of a timeline: one line per item, record times in sequence frames.
 * The `.otio` file is for tools; this is what an agent reads.
 *
 *   V4 2058–2281 emoji_dumpling.png src 0–149@29.97 fx:Opacity~,Transform:"Malice Slide In"~ scale=80
 */
import { type Clip, type EffectRef, type Timeline, TIMELINE_NAMESPACE } from "./otio.ts";

const num = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");

const formatValue = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(num).join(":")
    : typeof value === "number"
      ? num(value)
      : String(value);

const record = (clip: Clip): { startFrame: number; endFrame: number } | undefined => {
  const premiere = clip.metadata["premiere"] as
    | { record?: { startFrame: number; endFrame: number } }
    | undefined;
  return premiere?.record;
};

export const compactLine = (trackName: string, clip: Clip): string => {
  const span = record(clip);
  const { start_time, duration } = clip.source_range;
  const intent = (clip.metadata[TIMELINE_NAMESPACE] ?? {}) as {
    text?: string;
    transform?: Record<string, unknown>;
    effects?: ReadonlyArray<EffectRef>;
  };
  const parts = [
    trackName,
    span === undefined ? "?" : `${num(span.startFrame)}–${num(span.endFrame)}`,
    clip.name,
    `src ${num(start_time.value)}–${num(start_time.value + duration.value)}@${num(start_time.rate)}`,
  ];
  if (intent.text !== undefined)
    parts.push(`text:"${intent.text.replace(/\s*[\r\n]+\s*/g, " / ")}"`);
  if (intent.effects && intent.effects.length > 0) {
    const effects = intent.effects.map(
      (e) =>
        `${e.kind}${e.label !== e.kind ? `:"${e.label.replace(/\s*[\r\n]+\s*/g, " / ")}"` : ""}${e.animated ? "~" : ""}`,
    );
    parts.push(`fx:${effects.join(",")}`);
  }
  const { keyframes, ...statics } = intent.transform ?? {};
  for (const [key, value] of Object.entries(statics)) parts.push(`${key}=${formatValue(value)}`);
  // Animated params show their first and last keyframe values; the .otio has every keyframe.
  for (const [key, points] of Object.entries(
    (keyframes ?? {}) as Record<string, ReadonlyArray<readonly [number, unknown]>>,
  )) {
    const first = points[0];
    const last = points.at(-1);
    if (first !== undefined && last !== undefined) {
      parts.push(`${key}=${formatValue(first[1])}→${formatValue(last[1])}`);
    }
  }
  return parts.join(" ");
};

export const compactView = (timeline: Timeline): string => {
  const rate = timeline.global_start_time.rate;
  const lines = [`# ${timeline.name} · frames @${num(rate)} · ~ = animated`];
  for (const track of timeline.tracks.children) {
    for (const child of track.children) {
      if (child.OTIO_SCHEMA === "Clip.2") lines.push(compactLine(track.name, child));
    }
  }
  return lines.join("\n");
};
