import type { TimelineLayout } from "@t3tools/timeline/layout";
import { mediaSpanSeconds, timeScalarOf } from "@t3tools/timeline/speed";

import { type ClipTransform, gainDbAt, transformOf } from "./clipTransform";
import {
  audioFade,
  type ClipTransitions,
  type TransitionSpan,
  windowEnd,
  windowStart,
} from "./transitions";

/**
 * The arithmetic of timeline sound, with no Web Audio in it: where the playhead is at a clock
 * time, which stretch of which file a clip plays when, and how loud. The audio engine turns
 * the answers into scheduled buffers; the picture reads the same transport, so both follow one
 * clock.
 */

export interface TransportInput {
  /** The clock second playback starts at. */
  readonly t0: number;
  readonly frame: number;
  /** Signed speed: 1 is normal play, 2 double, -1 reverse. Never 0. */
  readonly speed: number;
  /** Timeline frames a second. */
  readonly rate: number;
  readonly duration: number;
  readonly loop: { readonly start: number; readonly end: number } | null;
  /** Forward playback stops here. */
  readonly stopAt: number | null;
}

/** One straight run of the playhead: from frame `f0` at clock time `t0` to `f1` at `t1`. */
export interface Leg {
  index: number;
  t0: number;
  t1: number;
  f0: number;
  f1: number;
}

/**
 * Where the playhead is at every clock time from one press of play (or one change of speed)
 * on: a first leg from where it stood to where playback ends or loops, then the loop's legs.
 * Fixed once made, so sound can be scheduled ahead against it to the sample and the picture
 * finds the same frame for the same time.
 */
export class Transport {
  /** Signed timeline frames per clock second. */
  readonly fps: number;
  readonly t0: number;
  readonly startFrame: number;
  private readonly firstEnd: number;
  private readonly firstEndsAt: number;
  private readonly loops: boolean;
  private readonly loopStart: number;
  private readonly loopEnd: number;
  private readonly period: number;

  constructor(input: TransportInput) {
    const { loop, rate, speed, duration } = input;
    this.fps = speed * rate;
    this.t0 = input.t0;
    let frame = input.frame;
    const looping = loop !== null && loop.end > loop.start;
    if (speed > 0) {
      if (frame >= duration) frame = looping ? loop.start : 0;
      if (looping && (frame >= loop.end || frame < loop.start)) frame = loop.start;
      const end = looping ? loop.end : duration;
      const stops = input.stopAt !== null && input.stopAt > frame && input.stopAt <= end;
      this.firstEnd = stops ? input.stopAt : end;
      this.loops = looping && !stops;
    } else {
      if (frame <= 0) frame = duration;
      this.firstEnd = Math.min(frame, looping ? loop.start : 0);
      this.loops = false;
    }
    this.startFrame = frame;
    this.firstEndsAt = this.t0 + (this.firstEnd - frame) / this.fps;
    this.loopStart = looping ? loop.start : 0;
    this.loopEnd = looping ? loop.end : duration;
    this.period = this.loops ? (this.loopEnd - this.loopStart) / this.fps : 0;
  }

  /** The clock time playback ends by itself; infinite while it loops. */
  get endsAt() {
    return this.loops ? Number.POSITIVE_INFINITY : this.firstEndsAt;
  }

  /** Where the playhead rests once playback has ended. */
  get finalFrame() {
    return this.firstEnd;
  }

  frameAt(t: number): number {
    if (t <= this.t0) return this.startFrame;
    if (t < this.firstEndsAt) return this.startFrame + (t - this.t0) * this.fps;
    if (!this.loops) return this.firstEnd;
    const into = (t - this.firstEndsAt) % this.period;
    return this.loopStart + into * this.fps;
  }

  /** The leg the playhead is on at `t`: 0 before and during the first, then one per loop. */
  legIndexAt(t: number): number {
    if (t < this.firstEndsAt || !this.loops) return 0;
    return 1 + Math.floor((t - this.firstEndsAt) / this.period);
  }

  /** Fills `into` with leg `index`. Pass one object to reuse it across calls. */
  leg(index: number, into: Leg): Leg {
    into.index = index;
    if (index <= 0) {
      into.t0 = this.t0;
      into.t1 = this.firstEndsAt;
      into.f0 = this.startFrame;
      into.f1 = this.firstEnd;
    } else {
      into.t0 = this.firstEndsAt + (index - 1) * this.period;
      into.t1 = into.t0 + this.period;
      into.f0 = this.loopStart;
      into.f1 = this.loopEnd;
    }
    return into;
  }
}

export const emptyLeg = (): Leg => ({ index: 0, t0: 0, t1: 0, f0: 0, f1: 0 });

/**
 * A cut in the middle of a clip would click, so each edge with no transition on it fades over
 * this long: short enough to still read as a cut.
 */
export const EDGE_FADE_SECONDS = 0.004;

/** What the engine needs to know to play one audio clip. */
export interface ClipAudio {
  readonly key: string;
  /** The clip's `target_url`, which names its media. */
  readonly target: string;
  /** The frames it is heard over: its own, widened by the transitions it fades through. */
  readonly from: number;
  readonly to: number;
  readonly startFrame: number;
  /** Source seconds at `startFrame`: the end of its media when it runs backwards. */
  readonly sourceAtStart: number;
  /** The clip's own speed, negative when reversed. */
  readonly scalar: number;
  /** Seconds the clip lasts on the timeline. */
  readonly seconds: number;
  readonly transform: ClipTransform;
  readonly fadeIn: TransitionSpan | null;
  readonly fadeOut: TransitionSpan | null;
  /**
   * The clip before (after) it on the track is the same media carrying straight on, as a
   * through edit leaves it: the two are joined with no fade and nothing is heard at the cut.
   */
  readonly joinsIn: boolean;
  readonly joinsOut: boolean;
  /** Its level moves over its whole length, not only at its edges. */
  readonly keyed: boolean;
}

const drawn = (span: TransitionSpan | null | undefined) =>
  span !== null && span !== undefined && span.kind !== null ? span : null;

/** Every enabled audio clip with media, in track order and then timeline order. */
export const planClipAudio = (
  layout: TimelineLayout,
  transitions: ReadonlyMap<string, ClipTransitions>,
): Array<ClipAudio> => {
  const plans: Array<ClipAudio> = [];
  for (const track of layout.tracks) {
    if (track.kind !== "Audio") continue;
    let previous: { plan: ClipAudio; index: number; endSource: number } | null = null;
    for (const item of track.clips) {
      const target = item.clip.media_references.DEFAULT_MEDIA.target_url;
      if (item.clip.enabled === false || target === "") {
        previous = null;
        continue;
      }
      const own = transitions.get(item.key);
      const scalar = timeScalarOf(item.clip);
      const span = mediaSpanSeconds(item.clip);
      const { duration } = item.clip.source_range;
      const seconds = duration.value / duration.rate;
      const sourceAtStart = scalar > 0 ? span.start : span.end;
      const fadeIn = drawn(own?.in);
      const fadeOut = drawn(own?.out);
      const transform = transformOf(item);
      const joinsIn =
        previous !== null &&
        fadeIn === null &&
        previous.plan.fadeOut === null &&
        previous.plan.target === target &&
        previous.plan.scalar === scalar &&
        previous.plan.to === item.startFrame &&
        Math.abs(previous.endSource - sourceAtStart) < 1e-4;
      if (joinsIn && previous !== null) {
        plans[previous.index] = { ...previous.plan, joinsOut: true };
      }
      const plan: ClipAudio = {
        key: item.key,
        target,
        from: windowStart(item, own),
        to: windowEnd(item, own),
        startFrame: item.startFrame,
        sourceAtStart,
        scalar,
        seconds,
        transform,
        fadeIn,
        fadeOut,
        joinsIn,
        joinsOut: false,
        keyed: (transform.keyframes?.["gain_db"]?.length ?? 0) > 0,
      };
      previous = { plan, index: plans.length, endSource: sourceAtStart + seconds * scalar };
      plans.push(plan);
    }
  }
  return plans;
};

/** How far a fade has come at `frame`, 0 to 1, held at its ends. */
const progressOf = (span: TransitionSpan, frame: number) =>
  Math.min(1, Math.max(0, (frame - span.start) / (span.end - span.start)));

/**
 * A clip's level at a timeline frame, as an amplitude: its gain and volume keyframes, the
 * fades of its transitions, and the short fade that keeps a plain cut from clicking.
 */
export const levelAt = (plan: ClipAudio, frame: number, rate: number): number => {
  const offset = Math.min(Math.max(0, (frame - plan.startFrame) / rate), plan.seconds);
  let level = 10 ** (gainDbAt(plan.transform, offset) / 20);
  const edge = EDGE_FADE_SECONDS * rate;
  if (plan.fadeIn !== null) {
    level *= audioFade(plan.fadeIn.kind, progressOf(plan.fadeIn, frame));
  } else if (!plan.joinsIn) {
    level *= Math.min(1, Math.max(0, (frame - plan.from) / edge));
  }
  if (plan.fadeOut !== null) {
    level *= audioFade(plan.fadeOut.kind, 1 - progressOf(plan.fadeOut, frame));
  } else if (!plan.joinsOut) {
    level *= Math.min(1, Math.max(0, (plan.to - frame) / edge));
  }
  return level;
};

/** Whether a clip's level is moving at `frame`, so it has to be drawn out point by point. */
export const levelMoves = (plan: ClipAudio, frame: number, rate: number): boolean => {
  if (plan.keyed) return true;
  const edge = EDGE_FADE_SECONDS * rate;
  if (plan.fadeIn !== null) {
    if (frame <= plan.fadeIn.end) return true;
  } else if (!plan.joinsIn && frame <= plan.from + edge) return true;
  if (plan.fadeOut !== null) return frame >= plan.fadeOut.start;
  return !plan.joinsOut && frame >= plan.to - edge;
};

/**
 * One clip on one leg: it sounds from clock time `tA` to `tB`, reading its source from `sA`
 * seconds at `m` source seconds per clock second (negative when the media runs backwards).
 */
export interface VoiceSpan {
  tA: number;
  tB: number;
  sA: number;
  m: number;
  /** The timeline frame at `tA`, and frames per clock second, for the level. */
  fA: number;
  fps: number;
  /** The clip joins its neighbour at this end, so the two are cross-faded, not cut. */
  joinStart: boolean;
  joinEnd: boolean;
}

export const emptySpan = (): VoiceSpan => ({
  tA: 0,
  tB: 0,
  sA: 0,
  m: 1,
  fA: 0,
  fps: 1,
  joinStart: false,
  joinEnd: false,
});

/** Where a clip sounds on a leg, or null when the leg never reaches it. */
export const voiceSpan = (
  plan: ClipAudio,
  leg: Leg,
  rate: number,
  into: VoiceSpan = emptySpan(),
): VoiceSpan | null => {
  const forward = leg.f1 >= leg.f0;
  const first = forward ? Math.max(plan.from, leg.f0) : Math.min(plan.to, leg.f0);
  const last = forward ? Math.min(plan.to, leg.f1) : Math.max(plan.from, leg.f1);
  if (forward ? last <= first : last >= first) return null;
  const fps = (leg.f1 - leg.f0) / (leg.t1 - leg.t0);
  into.fps = fps;
  into.fA = first;
  into.tA = leg.t0 + (first - leg.f0) / fps;
  into.tB = leg.t0 + (last - leg.f0) / fps;
  into.sA = plan.sourceAtStart + ((first - plan.startFrame) / rate) * plan.scalar;
  into.m = (fps / rate) * plan.scalar;
  into.joinStart = forward
    ? plan.joinsIn && first === plan.from
    : plan.joinsOut && first === plan.to;
  into.joinEnd = forward ? plan.joinsOut && last === plan.to : plan.joinsIn && last === plan.from;
  return into;
};

/**
 * Trims a span to the seconds its file holds, `low` to `high`: a transition's handle can run
 * off either end of the media, and there is nothing to play there. False when nothing is left.
 */
export const clampSpan = (span: VoiceSpan, low: number, high: number): boolean => {
  const { m } = span;
  const end = span.sA + (span.tB - span.tA) * m;
  const enter = m > 0 ? low : high;
  const leave = m > 0 ? high : low;
  if (m > 0 ? span.sA < enter : span.sA > enter) {
    const shift = (enter - span.sA) / m;
    span.tA += shift;
    span.fA += shift * span.fps;
    span.sA = enter;
    span.joinStart = false;
  }
  if (m > 0 ? end > leave : end < leave) {
    span.tB = span.tA + (leave - span.sA) / m;
    span.joinEnd = false;
  }
  return span.tB > span.tA;
};

/** How a file is cut into decoded chunks, in its own presentation seconds. */
export interface ChunkGrid {
  /** The second chunk 0 starts at: negative by the encoder's priming. */
  readonly origin: number;
  readonly chunkSeconds: number;
  /** Seconds each chunk holds past both its ends, which neighbours cross-fade over. */
  readonly guardSeconds: number;
}

/** One buffer to start: a stretch of one chunk, played forwards or backwards. */
export interface Segment {
  chunk: number;
  reversed: boolean;
  /** The clock time it starts. */
  when: number;
  /** The source second it starts from, and how many source seconds it plays. */
  from: number;
  length: number;
  /** It carries on from, or into, the same sound in another buffer: fade across the guard. */
  fadeIn: boolean;
  fadeOut: boolean;
  /** The clock time the next segment of this voice starts; `tB` when this is the last. */
  next: number;
}

export const emptySegment = (): Segment => ({
  chunk: 0,
  reversed: false,
  when: 0,
  from: 0,
  length: 0,
  fadeIn: false,
  fadeOut: false,
  next: 0,
});

const EPSILON = 1e-9;

/**
 * The segment a voice plays from clock time `t`: the rest of the chunk the source is in, up to
 * the end of the span. A segment that hands over to another buffer runs one guard past its
 * chunk and fades out across it while the next fades in, so the join is never a bare cut.
 */
export const segmentAt = (
  span: VoiceSpan,
  grid: ChunkGrid,
  t: number,
  into: Segment = emptySegment(),
): Segment => {
  const { m } = span;
  const source = span.sA + (t - span.tA) * m;
  const end = span.sA + (span.tB - span.tA) * m;
  const position = (source - grid.origin) / grid.chunkSeconds;
  into.when = t;
  into.from = source;
  if (m > 0) {
    const chunk = Math.floor(position + EPSILON);
    const chunkStart = grid.origin + chunk * grid.chunkSeconds;
    const chunkEnd = chunkStart + grid.chunkSeconds;
    const continues = chunkEnd < end - EPSILON;
    const stop = continues ? chunkEnd : end;
    into.chunk = chunk;
    into.reversed = false;
    into.fadeOut = continues || span.joinEnd;
    into.length = stop - source + (into.fadeOut ? grid.guardSeconds : 0);
    into.fadeIn = t <= span.tA + EPSILON ? span.joinStart : Math.abs(source - chunkStart) < 1e-6;
    into.next = continues ? span.tA + (stop - span.sA) / m : span.tB;
    return into;
  }
  const chunk = Math.ceil(position - EPSILON) - 1;
  const chunkStart = grid.origin + chunk * grid.chunkSeconds;
  const continues = chunkStart > end + EPSILON;
  const stop = continues ? chunkStart : end;
  into.chunk = chunk;
  into.reversed = true;
  into.fadeOut = continues || span.joinEnd;
  into.length = source - stop + (into.fadeOut ? grid.guardSeconds : 0);
  into.fadeIn =
    t <= span.tA + EPSILON
      ? span.joinStart
      : Math.abs(source - (chunkStart + grid.chunkSeconds)) < 1e-6;
  into.next = continues ? span.tA + (stop - span.sA) / m : span.tB;
  return into;
};
