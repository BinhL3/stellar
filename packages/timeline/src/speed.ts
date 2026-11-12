/**
 * Speed changes: OTIO's `LinearTimeWarp` in a clip's `effects`. A clip stays
 * `source_range.duration` long on the track; its media starts at `source_range.start_time`,
 * runs `duration × |scalar|`, and plays from its end back when the scalar is negative.
 */
import type { Clip, LinearTimeWarp } from "./otio.ts";

/** 1 for normal speed, 2 for double, -1 for reverse. Never 0. */
export const timeScalarOf = (clip: Clip): number => {
  const warp = clip.effects?.find((effect) => effect.OTIO_SCHEMA === "LinearTimeWarp.1");
  const scalar = warp?.time_scalar;
  return scalar === undefined || !Number.isFinite(scalar) || scalar === 0 ? 1 : scalar;
};

export const linearTimeWarp = (timeScalar: number): LinearTimeWarp => ({
  OTIO_SCHEMA: "LinearTimeWarp.1",
  name: "",
  effect_name: "LinearTimeWarp",
  time_scalar: timeScalar,
  metadata: {},
});

/** The media a clip plays, in seconds of its source, lowest first whatever the direction. */
export const mediaSpanSeconds = (clip: Clip): { readonly start: number; readonly end: number } => {
  const { start_time, duration } = clip.source_range;
  const start = start_time.value / start_time.rate;
  return { start, end: start + (duration.value / duration.rate) * Math.abs(timeScalarOf(clip)) };
};

/**
 * Source seconds shown `offset` seconds into the clip. Not clamped: a transition plays a clip
 * before its start and past its end, from the media's handles.
 */
export const sourceSecondsAt = (clip: Clip, offset: number): number => {
  const scalar = timeScalarOf(clip);
  const span = mediaSpanSeconds(clip);
  return scalar > 0 ? span.start + offset * scalar : span.end + offset * scalar;
};

/** Seconds into the clip at which it shows `source` seconds of its media; inverse of the above. */
export const offsetAtSourceSeconds = (clip: Clip, source: number): number => {
  const scalar = timeScalarOf(clip);
  const span = mediaSpanSeconds(clip);
  return (source - (scalar > 0 ? span.start : span.end)) / scalar;
};

/**
 * Where a clip sits along its own playback, in timeline frames: two pieces cut from one clip
 * are neighbours here whatever its speed or direction, and a head trim of n frames moves
 * `start` by n. At normal speed this is the source range in timeline frames. Spans of clips
 * with different speeds do not compare.
 */
export const playSpan = (
  clip: Clip,
  rate: number,
): { readonly start: number; readonly end: number } => {
  const scalar = timeScalarOf(clip);
  const { duration } = clip.source_range;
  const length = (duration.value / duration.rate) * rate;
  const span = mediaSpanSeconds(clip);
  const start = scalar > 0 ? (span.start / scalar) * rate : (span.end / scalar) * rate;
  return { start, end: start + length };
};

/**
 * The source start a piece of `clip` has when it keeps `lengthFrames` timeline frames from
 * `shiftFrames` in, in the units of `source_range.start_time`.
 */
export const reslicedSourceStart = (
  clip: Clip,
  rate: number,
  shiftFrames: number,
  lengthFrames: number,
): number => {
  const scalar = timeScalarOf(clip);
  const { start_time, duration } = clip.source_range;
  const toSource = (start_time.rate / rate) * Math.abs(scalar);
  if (scalar > 0) return start_time.value + shiftFrames * toSource;
  const whole = (duration.value / duration.rate) * rate;
  return start_time.value + (whole - shiftFrames - lengthFrames) * toSource;
};
