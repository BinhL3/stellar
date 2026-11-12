import type { LaidOutClip, TimelineLayout } from "@t3tools/timeline/layout";
import type { Clip } from "@t3tools/timeline/otio";
import { describe, expect, it } from "vite-plus/test";

import {
  type ChunkGrid,
  clampSpan,
  EDGE_FADE_SECONDS,
  emptyLeg,
  levelAt,
  levelMoves,
  originalCue,
  originalsNear,
  planClipAudio,
  segmentAt,
  soundSourceOf,
  Transport,
  voiceSpan,
} from "./audioSchedule";
import { planTransitions } from "./transitions";

const RATE = 30;

const clip = (
  key: string,
  startFrame: number,
  frames: number,
  options: {
    readonly file?: string;
    readonly sourceFrame?: number;
    readonly speed?: number;
    readonly transform?: unknown;
  } = {},
): LaidOutClip => ({
  key,
  startFrame,
  endFrame: startFrame + frames,
  clip: {
    OTIO_SCHEMA: "Clip.2",
    name: key,
    source_range: {
      OTIO_SCHEMA: "TimeRange.1",
      start_time: { OTIO_SCHEMA: "RationalTime.1", value: options.sourceFrame ?? 0, rate: RATE },
      duration: { OTIO_SCHEMA: "RationalTime.1", value: frames, rate: RATE },
    },
    ...(options.speed === undefined
      ? {}
      : {
          effects: [
            {
              OTIO_SCHEMA: "LinearTimeWarp.1",
              name: "",
              effect_name: "LinearTimeWarp",
              time_scalar: options.speed,
              metadata: {},
            },
          ],
        }),
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: "ExternalReference.1",
        target_url: options.file ?? `${key}.wav`,
        metadata: {},
      },
    },
    active_media_reference_key: "DEFAULT_MEDIA",
    enabled: true,
    metadata: options.transform === undefined ? {} : { stellar: { transform: options.transform } },
  } satisfies Clip,
});

const layoutOf = (
  clips: ReadonlyArray<LaidOutClip>,
  transitions?: ReadonlyArray<Record<string, unknown>>,
): TimelineLayout => ({
  rate: RATE,
  durationFrames: Math.max(...clips.map((item) => item.endFrame)),
  tracks: [
    {
      name: "A1",
      kind: "Audio",
      clips,
      metadata: transitions === undefined ? {} : { premiere: { transitions } },
    },
  ],
});

const plansOf = (
  clips: ReadonlyArray<LaidOutClip>,
  transitions?: ReadonlyArray<Record<string, unknown>>,
) => {
  const layout = layoutOf(clips, transitions);
  return planClipAudio(layout, planTransitions(layout));
};

const transport = (input: Partial<ConstructorParameters<typeof Transport>[0]>) =>
  new Transport({
    t0: 10,
    frame: 0,
    speed: 1,
    rate: RATE,
    duration: 300,
    loop: null,
    stopAt: null,
    ...input,
  });

describe("Transport", () => {
  it("holds the start frame until its clock time, then runs at the speed", () => {
    const play = transport({ frame: 30 });
    expect(play.frameAt(9.5)).toBe(30);
    expect(play.frameAt(11)).toBe(60);
    expect(transport({ frame: 30, speed: 2 }).frameAt(11)).toBe(90);
    expect(transport({ frame: 90, speed: -1 }).frameAt(11)).toBe(60);
  });

  it("ends at the timeline's end, at a stop point, and at the start in reverse", () => {
    const toEnd = transport({ frame: 270 });
    expect(toEnd.endsAt).toBe(11);
    expect(toEnd.frameAt(12)).toBe(300);
    expect(toEnd.finalFrame).toBe(300);

    const toStop = transport({ frame: 30, stopAt: 60 });
    expect(toStop.endsAt).toBe(11);
    expect(toStop.finalFrame).toBe(60);

    const back = transport({ frame: 60, speed: -2 });
    expect(back.endsAt).toBe(11);
    expect(back.finalFrame).toBe(0);
  });

  it("restarts from the top when play is pressed at the end, and from the end in reverse", () => {
    expect(transport({ frame: 300 }).startFrame).toBe(0);
    expect(transport({ frame: 0, speed: -1 }).startFrame).toBe(300);
  });

  it("loops without ending, one leg per pass, and pulls a playhead outside the loop into it", () => {
    const loop = transport({ frame: 90, loop: { start: 60, end: 120 } });
    expect(loop.endsAt).toBe(Number.POSITIVE_INFINITY);
    expect(loop.frameAt(10.5)).toBe(105);
    // The first leg ends at 11 s; each pass of the loop then takes 2 s.
    expect(loop.frameAt(11)).toBe(60);
    expect(loop.frameAt(12.5)).toBe(105);
    expect(loop.frameAt(13.5)).toBeCloseTo(75, 9);
    expect(loop.legIndexAt(10.9)).toBe(0);
    expect(loop.legIndexAt(11)).toBe(1);
    expect(loop.legIndexAt(13.1)).toBe(2);
    expect(loop.leg(2, emptyLeg())).toEqual({ index: 2, t0: 13, t1: 15, f0: 60, f1: 120 });

    expect(transport({ frame: 200, loop: { start: 60, end: 120 } }).startFrame).toBe(60);
    // Play to a stop point inside the loop stops there instead of looping.
    expect(transport({ frame: 70, loop: { start: 60, end: 120 }, stopAt: 100 }).endsAt).toBe(11);
  });
});

describe("planClipAudio", () => {
  it("places each clip's source and widens it by its transitions", () => {
    const plans = plansOf(
      [clip("a", 0, 60, { sourceFrame: 30 }), clip("b", 60, 60, { sourceFrame: 90 })],
      [{ name: "Constant Power", startFrame: 45, endFrame: 75, cutFrame: 60 }],
    );
    expect(plans.map((plan) => [plan.key, plan.from, plan.to, plan.sourceAtStart])).toEqual([
      ["a", 0, 75, 1],
      ["b", 45, 120, 3],
    ]);
    expect(plans[0]?.fadeOut?.kind).toBe("constant-power");
    expect(plans[1]?.fadeIn?.kind).toBe("constant-power");
  });

  it("starts a reversed clip from the end of its media", () => {
    const [plan] = plansOf([clip("r", 0, 60, { sourceFrame: 30, speed: -2 })]);
    // Two seconds at double speed cover source 1 s to 5 s, played from 5 s down.
    expect(plan).toMatchObject({ sourceAtStart: 5, scalar: -2, seconds: 2 });
  });

  it("joins the two halves of a through edit and nothing else", () => {
    const plans = plansOf([
      clip("a", 0, 60, { file: "take.wav", sourceFrame: 0 }),
      clip("b", 60, 60, { file: "take.wav", sourceFrame: 60 }),
      // The same file, but it skips a second: a real cut.
      clip("c", 120, 60, { file: "take.wav", sourceFrame: 150 }),
    ]);
    expect(plans.map((plan) => [plan.joinsIn, plan.joinsOut])).toEqual([
      [false, true],
      [true, false],
      [false, false],
    ]);
  });
});

describe("levelAt", () => {
  it("fades a plain cut over a few milliseconds and leaves the middle at the clip's gain", () => {
    const [plan] = plansOf([clip("a", 30, 60, { transform: { gain_db: -6 } })]);
    const edge = EDGE_FADE_SECONDS * RATE;
    const gain = 10 ** (-6 / 20);
    expect(levelAt(plan!, 30, RATE)).toBe(0);
    expect(levelAt(plan!, 30 + edge / 2, RATE)).toBeCloseTo(gain / 2, 9);
    expect(levelAt(plan!, 60, RATE)).toBeCloseTo(gain, 9);
    expect(levelAt(plan!, 90 - edge / 2, RATE)).toBeCloseTo(gain / 2, 9);
    expect(levelAt(plan!, 90, RATE)).toBe(0);
    expect(levelMoves(plan!, 30, RATE)).toBe(true);
    expect(levelMoves(plan!, 60, RATE)).toBe(false);
    expect(levelMoves(plan!, 90, RATE)).toBe(true);
  });

  it("does not fade the inside edges of a through edit", () => {
    const [first, second] = plansOf([
      clip("a", 0, 60, { file: "take.wav", sourceFrame: 0 }),
      clip("b", 60, 60, { file: "take.wav", sourceFrame: 60 }),
    ]);
    expect(levelAt(first!, 60, RATE)).toBe(1);
    expect(levelAt(second!, 60, RATE)).toBe(1);
  });

  it.each([
    ["Constant Power", Math.SQRT1_2, Math.SQRT1_2],
    ["Constant Gain", 0.5, 0.5],
    ["Exponential Fade", 0.25, 0.25],
  ])("crossfades with %s", (name, outgoing, incoming) => {
    const [a, b] = plansOf(
      [clip("a", 0, 60), clip("b", 60, 60)],
      [{ name, startFrame: 40, endFrame: 80, cutFrame: 60 }],
    );
    expect(levelAt(a!, 40, RATE)).toBeCloseTo(1, 9);
    expect(levelAt(a!, 60, RATE)).toBeCloseTo(outgoing, 9);
    // The fade ends at silence exactly, on the last frame it is heard.
    expect(levelAt(a!, 80, RATE)).toBeCloseTo(0, 9);
    expect(levelAt(b!, 40, RATE)).toBeCloseTo(0, 9);
    expect(levelAt(b!, 60, RATE)).toBeCloseTo(incoming, 9);
    expect(levelAt(b!, 80, RATE)).toBeCloseTo(1, 9);
  });

  it("follows volume keyframes with linear, held and eased stretches", () => {
    const keyed = (keyframes: ReadonlyArray<unknown>) =>
      plansOf([clip("a", 0, 120, { transform: { keyframes: { gain_db: keyframes } } })])[0]!;
    const db = (level: number) => 20 * Math.log10(level);
    const linear = keyed([
      [1, 0],
      [3, -20],
    ]);
    expect(db(levelAt(linear, 60, RATE))).toBeCloseTo(-10, 6);
    expect(levelMoves(linear, 60, RATE)).toBe(true);
    const held = keyed([
      [1, 0, "hold"],
      [3, -20],
    ]);
    expect(db(levelAt(held, 89, RATE))).toBeCloseTo(0, 6);
    expect(db(levelAt(held, 90, RATE))).toBeCloseTo(-20, 6);
    const eased = keyed([
      [1, 0, [0.42, 0, 1, 1]],
      [3, -20],
    ]);
    // Ease-in is behind the straight line at the halfway point.
    expect(db(levelAt(eased, 60, RATE))).toBeGreaterThan(-8);
    expect(db(levelAt(eased, 60, RATE))).toBeLessThan(-4);
  });
});

describe("voiceSpan", () => {
  const leg = (f0: number, f1: number, t0 = 10, speed = 1) => ({
    index: 0,
    t0,
    t1: t0 + Math.abs(f1 - f0) / RATE / Math.abs(speed),
    f0,
    f1,
  });

  it("starts a clip on its frame, from its source, at the transport's speed", () => {
    const [plan] = plansOf([clip("a", 30, 60, { sourceFrame: 90 })]);
    expect(voiceSpan(plan!, leg(0, 300), RATE)).toMatchObject({ tA: 11, tB: 13, sA: 3, m: 1 });
    // Starting inside the clip plays from the matching source time.
    expect(voiceSpan(plan!, leg(45, 300), RATE)).toMatchObject({ tA: 10, tB: 11.5, sA: 3.5 });
    // Double speed halves the time and doubles the rate through the source.
    expect(voiceSpan(plan!, leg(0, 300, 10, 2), RATE)).toMatchObject({
      tA: 10.5,
      tB: 11.5,
      sA: 3,
      m: 2,
    });
    expect(voiceSpan(plan!, leg(100, 300), RATE)).toBeNull();
  });

  it("plays backwards from the clip's end when the transport runs in reverse", () => {
    const [plan] = plansOf([clip("a", 30, 60, { sourceFrame: 90 })]);
    expect(voiceSpan(plan!, leg(120, 0), RATE)).toMatchObject({ tA: 11, tB: 13, sA: 5, m: -1 });
  });

  it("combines the clip's own speed and direction with the transport's", () => {
    const [reversed] = plansOf([clip("r", 0, 60, { sourceFrame: 30, speed: -2 })]);
    expect(voiceSpan(reversed!, leg(0, 300), RATE)).toMatchObject({ sA: 5, m: -2 });
    // A reversed clip under a reversed transport plays its media forwards.
    expect(voiceSpan(reversed!, leg(60, 0), RATE)).toMatchObject({ sA: 1, m: 2 });
  });

  it("trims what falls outside the file, moving the start with it", () => {
    const [plan] = plansOf([clip("a", 0, 90, { sourceFrame: 0 })]);
    const span = voiceSpan(plan!, leg(0, 300), RATE)!;
    expect(clampSpan(span, 0.5, 2)).toBe(true);
    expect(span).toMatchObject({ tA: 10.5, tB: 12, sA: 0.5, fA: 15 });
    expect(clampSpan(voiceSpan(plan!, leg(0, 300), RATE)!, 5, 9)).toBe(false);
  });
});

describe("segmentAt", () => {
  // Chunks of 2 s starting 0.02 s before the media, with a 5 ms guard.
  const grid: ChunkGrid = { origin: -0.02, chunkSeconds: 2, guardSeconds: 0.005 };
  const span = (overrides: Record<string, unknown>) => ({
    tA: 10,
    tB: 15,
    sA: 1,
    m: 1,
    fA: 0,
    fps: RATE,
    joinStart: false,
    joinEnd: false,
    ...overrides,
  });

  it("plays to the end of the chunk and hands over with a fade across the guard", () => {
    const first = segmentAt(span({}), grid, 10);
    expect(first).toMatchObject({ chunk: 0, reversed: false, when: 10, from: 1, fadeIn: false });
    // The chunk ends at 1.98 s of source, 0.98 s in; it plays one guard past that.
    expect(first.length).toBeCloseTo(0.985, 9);
    expect(first.fadeOut).toBe(true);
    expect(first.next).toBeCloseTo(10.98, 9);

    const second = segmentAt(span({}), grid, first.next);
    expect(second).toMatchObject({ chunk: 1, fadeIn: true, fadeOut: true });
    expect(second.from).toBeCloseTo(1.98, 9);
    expect(second.next).toBeCloseTo(12.98, 9);

    const last = segmentAt(span({}), grid, 14.98);
    expect(last).toMatchObject({ chunk: 3, fadeIn: true, fadeOut: false, next: 15 });
    expect(last.length).toBeCloseTo(0.02, 9);
  });

  it("covers the source at speed: twice the source in the same clock time", () => {
    const segment = segmentAt(span({ m: 2, tB: 12 }), grid, 10);
    expect(segment.length).toBeCloseTo(0.985, 9);
    expect(segment.next).toBeCloseTo(10.49, 9);
  });

  it("walks chunks downwards in reverse, from the top of each", () => {
    const backwards = span({ sA: 5, m: -1, tB: 14 });
    const first = segmentAt(backwards, grid, 10);
    // 5 s is in the chunk from 3.98 s; it plays down to there, and one guard past.
    expect(first).toMatchObject({ chunk: 2, reversed: true, from: 5, fadeOut: true });
    expect(first.length).toBeCloseTo(1.025, 9);
    expect(first.next).toBeCloseTo(11.02, 9);
    const second = segmentAt(backwards, grid, first.next);
    expect(second).toMatchObject({ chunk: 1, reversed: true, fadeIn: true });
    expect(second.from).toBeCloseTo(3.98, 9);
  });

  it("fades into and out of a through edit's neighbour instead of cutting", () => {
    const joined = span({ tB: 10.5, joinStart: true, joinEnd: true });
    const segment = segmentAt(joined, grid, 10);
    expect(segment).toMatchObject({ fadeIn: true, fadeOut: true, next: 10.5 });
    expect(segment.length).toBeCloseTo(0.505, 9);
  });
});

describe("sound for a clip with no rendition", () => {
  it("plays the rendition when there is one, the original until then, and nothing with no file", () => {
    expect(soundSourceOf({ audio: "a.m4a", audioProxy: true })).toBe("rendition");
    // The proxy is still building, its build failed, or the machine has no ffmpeg.
    expect(soundSourceOf({ audio: "a.mov" })).toBe("original");
    expect(soundSourceOf({ audio: "a.mov", audioProxy: false })).toBe("original");
    // A still, a URL not signed yet, or media the project does not know.
    expect(soundSourceOf({ audio: null })).toBe("none");
    expect(soundSourceOf({ audio: null, audioProxy: true })).toBe("none");
    expect(soundSourceOf(undefined)).toBe("none");
  });

  it("offers the clips under and just ahead of the playhead, earliest first", () => {
    const plans = plansOf([clip("a", 0, 60), clip("b", 60, 60), clip("c", 120, 60)]);
    const into: Array<(typeof plans)[number]> = [];
    const near = (frame: number) =>
      into.slice(0, originalsNear(plans, frame, 3 * RATE, into)).map((plan) => plan.key);
    expect(near(0)).toEqual(["a", "b"]);
    // A clip sounding is ahead of the one coming in, so a cap on elements never cuts it off.
    expect(near(59)).toEqual(["a", "b", "c"]);
    expect(near(60)).toEqual(["b", "c"]);
    expect(near(180)).toEqual([]);
  });

  it("is heard under the playhead in forward play, on the source second the frame is at", () => {
    const [plan] = plansOf([clip("a", 30, 90, { sourceFrame: 60, transform: { gain_db: -6 } })]);
    const cue = originalCue(plan!, 60, RATE, RATE);
    expect(cue.mode).toBe("sound");
    expect(cue.at).toBeCloseTo(3, 9);
    expect(cue.speed).toBe(1);
    expect(cue.level).toBeCloseTo(10 ** (-6 / 20), 6);
    // A sped-up clip runs through its source faster, at double shuttle faster again.
    const [fast] = plansOf([clip("a", 0, 90, { speed: 1.5 })]);
    expect(originalCue(fast!, 30, RATE, RATE)).toMatchObject({ mode: "sound", speed: 1.5 });
    expect(originalCue(fast!, 30, RATE, RATE).at).toBeCloseTo(1.5, 9);
  });

  it("stays silent in reverse, above double speed and for a reversed clip", () => {
    const [plan] = plansOf([clip("a", 0, 90)]);
    expect(originalCue(plan!, 30, -RATE, RATE)).toMatchObject({ mode: "wait", level: 0 });
    expect(originalCue(plan!, 30, 2 * RATE, RATE).mode).toBe("sound");
    expect(originalCue(plan!, 30, 4 * RATE, RATE)).toMatchObject({ mode: "wait", level: 0 });
    const [fast] = plansOf([clip("a", 0, 90, { speed: 1.5 })]);
    expect(originalCue(fast!, 30, 2 * RATE, RATE).mode).toBe("wait");
    const [reversed] = plansOf([clip("a", 0, 90, { speed: -1 })]);
    expect(originalCue(reversed!, 30, RATE, RATE)).toMatchObject({ mode: "wait", level: 0 });
  });

  it("waits paused at the playhead, and runs up to a cut unheard so it arrives on time", () => {
    const [plan] = plansOf([clip("a", 60, 90, { sourceFrame: 60 })]);
    // Paused on the clip, it rests on the playhead's source second.
    expect(originalCue(plan!, 90, 0, RATE)).toMatchObject({ mode: "wait", level: 0 });
    expect(originalCue(plan!, 90, 0, RATE).at).toBeCloseTo(3, 9);
    // A second before the cut it waits at the point its run-up starts from.
    const waiting = originalCue(plan!, 30, RATE, RATE);
    expect(waiting.mode).toBe("wait");
    expect(waiting.at).toBeCloseTo(2 - 0.3, 9);
    // 0.2 s before the cut it is playing, 0.2 s of source short of where the clip opens.
    const running = originalCue(plan!, 54, RATE, RATE);
    expect(running).toMatchObject({ mode: "preroll", level: 0, speed: 1 });
    expect(running.at).toBeCloseTo(2 - 0.2, 9);
    // A clip that opens on its file's first sample has nothing to run up through.
    const [opening] = plansOf([clip("a", 60, 90)]);
    expect(originalCue(opening!, 54, RATE, RATE)).toMatchObject({ mode: "wait", at: 0 });
  });
});
