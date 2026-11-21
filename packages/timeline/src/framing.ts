/**
 * What the timeline does to the picture that playback in the right app hides: a source that
 * doesn't fit the frame, a clip played much faster or slower, and text placed where an app's
 * own buttons cover it. Pure; the render check reports these beside what it found in the export.
 */
import { layoutTimeline, type LaidOutClip } from "./layout.ts";
import { type Timeline, TIMELINE_NAMESPACE } from "./otio.ts";
import type { TextStyle } from "./premiere/textStyle.ts";
import { coveredEdges, type FrameBox, type Insets } from "./safeZones.ts";
import { timeScalarOf } from "./speed.ts";

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

interface Motion {
  readonly position?: ReadonlyArray<number>;
  readonly anchor_point?: ReadonlyArray<number>;
  readonly scale?: number;
  readonly scale_width?: number;
  readonly uniform_scale?: boolean;
  readonly rotation?: number;
  readonly keyframes?: Readonly<Record<string, unknown>>;
}

interface Stellar {
  readonly transform?: Motion;
  readonly mediaRotation?: number;
  readonly caption?: boolean;
  readonly text?: string;
  readonly textPosition?: ReadonlyArray<number>;
  readonly textStyle?: TextStyle;
}

const stellarOf = (item: LaidOutClip): Stellar =>
  (item.clip.metadata[TIMELINE_NAMESPACE] as Stellar | undefined) ?? {};

const isCaptionTrack = (metadata: Readonly<Record<string, unknown>> | undefined) =>
  (metadata?.[TIMELINE_NAMESPACE] as { captions?: boolean } | undefined)?.captions === true;

export interface ClipFraming {
  readonly track: string;
  readonly name: string;
  readonly startFrame: number;
  /** The media's picture as Premiere lays it, after its rotation. */
  readonly source: FrameSize;
  /** Share of the source picture outside the frame, 0 to 1. */
  readonly outside: number;
  /** Share of the frame the clip leaves uncovered (black, or the track below). */
  readonly uncovered: number;
  /** Scale or position is keyframed: the share is of the clip's resting values. */
  readonly animated: boolean;
}

/**
 * How each video clip whose source isn't the frame's size sits in the frame, from Premiere's
 * Motion (position and anchor as fractions, scale in percent of the media's own pixels).
 * Crop is not counted. `sizes` are the media's display sizes, as the proxy index has them.
 */
export const clipFraming = (
  timeline: Timeline,
  frame: FrameSize,
  sizes: ReadonlyMap<string, FrameSize>,
): Array<ClipFraming> => {
  const out: Array<ClipFraming> = [];
  for (const track of layoutTimeline(timeline).tracks) {
    if (track.kind !== "Video" || isCaptionTrack(track.metadata)) continue;
    for (const item of track.clips) {
      if (!item.clip.enabled) continue;
      const size = sizes.get(item.clip.media_references.DEFAULT_MEDIA.target_url);
      if (size === undefined || size.width <= 0 || size.height <= 0) continue;
      const stellar = stellarOf(item);
      const motion = stellar.transform ?? {};
      const turned = (stellar.mediaRotation ?? 0) % 180 !== 0;
      const rotation = (((motion.rotation ?? 0) % 360) + 360) % 360;
      // A tilted picture's corners aren't a rectangle on the frame; only quarter turns are measured.
      if (rotation % 90 !== 0) continue;
      const sideways = turned !== (rotation % 180 === 90);
      const layer = sideways ? { width: size.height, height: size.width } : size;
      if (layer.width === frame.width && layer.height === frame.height) continue;
      const scaleY = (motion.scale ?? 100) / 100;
      const scaleX = motion.uniform_scale === false ? (motion.scale_width ?? 100) / 100 : scaleY;
      const [x = 0.5, y = 0.5] = motion.position ?? [];
      const [anchorX = 0.5, anchorY = 0.5] = motion.anchor_point ?? [];
      const width = layer.width * scaleX;
      const height = layer.height * scaleY;
      const left = x * frame.width - anchorX * width;
      const top = y * frame.height - anchorY * height;
      const shown =
        Math.max(0, Math.min(left + width, frame.width) - Math.max(left, 0)) *
        Math.max(0, Math.min(top + height, frame.height) - Math.max(top, 0));
      const keyframed = Object.keys(motion.keyframes ?? {});
      out.push({
        track: track.name,
        name: item.clip.name,
        startFrame: Math.round(item.startFrame),
        source: layer,
        outside: width * height === 0 ? 0 : 1 - shown / (width * height),
        uncovered: 1 - shown / (frame.width * frame.height),
        animated: keyframed.some((key) => ["scale", "scale_width", "position"].includes(key)),
      });
    }
  }
  return out;
};

/** Faster than this, or slower than its inverse, is a speed change the user should hear about. */
export const LARGE_SPEED = 1.25;

export interface SpeedChange {
  readonly track: string;
  readonly name: string;
  readonly startFrame: number;
  /** 2 is double speed, 0.5 half, negative plays backwards. */
  readonly scalar: number;
}

/** Clips played at `LARGE_SPEED` or more, `1 / LARGE_SPEED` or less, or backwards. */
export const largeSpeedChanges = (timeline: Timeline): Array<SpeedChange> => {
  const seen = new Set<string>();
  const out: Array<SpeedChange> = [];
  for (const track of layoutTimeline(timeline).tracks) {
    for (const item of track.clips) {
      const scalar = timeScalarOf(item.clip);
      const speed = Math.abs(scalar);
      if (scalar > 0 && speed < LARGE_SPEED && speed > 1 / LARGE_SPEED) continue;
      // A file's picture and sound are linked clips with one speed: listed once.
      const key = `${item.clip.name}\n${Math.round(item.startFrame)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        track: track.name,
        name: item.clip.name,
        startFrame: Math.round(item.startFrame),
        scalar,
      });
    }
  }
  return out.toSorted((a, b) => a.startFrame - b.startFrame);
};

export interface PlacedText {
  readonly track: string;
  readonly startFrame: number;
  readonly text: string;
  /** Where the words sit, estimated from the anchor, size and line count; null when unknown. */
  readonly box: FrameBox | null;
}

// A line of type is about this many sizes tall, and an average letter this wide.
const LINE_HEIGHT = 1.2;
const LETTER_WIDTH = 0.55;

/**
 * Captions and text layers on the timeline with where their words sit. A caption track's
 * cues keep their position in Premiere's track style, which isn't read, so their box is null.
 */
export const placedText = (timeline: Timeline, frame: FrameSize): Array<PlacedText> => {
  const out: Array<PlacedText> = [];
  for (const track of layoutTimeline(timeline).tracks) {
    if (track.kind !== "Video") continue;
    for (const item of track.clips) {
      const stellar = stellarOf(item);
      const text = stellar.text?.trim() ?? "";
      if (!item.clip.enabled || text === "") continue;
      const lines = text.split(/[\r\n]+/);
      const [x, y] = stellar.textPosition ?? [];
      const size = stellar.textStyle?.runs.find((run) => run.size !== undefined)?.size;
      const scale =
        ((stellar.textStyle?.scale ?? 100) / 100) * ((stellar.transform?.scale ?? 100) / 100);
      let box: FrameBox | null = null;
      if (x !== undefined && y !== undefined && size !== undefined) {
        const height = (lines.length * size * LINE_HEIGHT * scale) / frame.height;
        const width =
          (Math.max(...lines.map((line) => line.length)) * size * LETTER_WIDTH * scale) /
          frame.width;
        const align = stellar.textStyle?.align ?? "center";
        const left = align === "left" ? x : align === "right" ? x - width : x - width / 2;
        box = { left, right: left + width, top: y - height / 2, bottom: y + height / 2 };
      }
      out.push({
        track: track.name,
        startFrame: Math.round(item.startFrame),
        text: text.replace(/\s+/g, " "),
        box,
      });
    }
  }
  return out.toSorted((a, b) => a.startFrame - b.startFrame);
};

/** The placed text whose words reach into a covered strip, with the edges it reaches. */
export const textInSafeZones = (
  texts: ReadonlyArray<PlacedText>,
  insets: Insets,
): Array<{ readonly text: PlacedText; readonly edges: ReadonlyArray<keyof Insets> }> =>
  texts.flatMap((text) => {
    if (text.box === null) return [];
    const edges = coveredEdges(text.box, insets);
    return edges.length === 0 ? [] : [{ text, edges }];
  });
