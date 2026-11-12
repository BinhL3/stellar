import type { LaidOutClip, TimelineLayout } from "@t3tools/timeline/layout";
import { describe, expect, it } from "vite-plus/test";

import type { DecodedChunk } from "./audioCache";
import { AudioEngine, type AudioSource } from "./audioEngine";
import { Transport } from "./audioSchedule";
import { planTransitions } from "./transitions";

/**
 * The engine rendered through an `OfflineAudioContext` and checked sample by sample. Sources
 * are signals with a known value at every source second (a ramp says which second is playing,
 * a constant shows the level), so each assertion reads what played, when and how loud.
 */

const RATE = 30;
const SAMPLE_RATE = 48000;
const CHUNK = 131072;
const GUARD = 256;
/** Playback starts here, clear of the context's first quantum. */
const T0 = 0.1;

const signalSource = (
  signal: (seconds: number) => number,
  seconds: number,
  sampleRate = SAMPLE_RATE,
): AudioSource => {
  const origin = -1024 / sampleRate;
  const total = Math.ceil((seconds - origin) * sampleRate);
  const made = new Map<number, DecodedChunk>();
  const reversed = new Map<DecodedChunk, AudioBuffer>();
  const chunkSeconds = CHUNK / sampleRate;
  return {
    grid: { origin, chunkSeconds, guardSeconds: GUARD / sampleRate },
    start: 0,
    end: origin + total / sampleRate,
    chunkAt: (at) => Math.max(0, Math.floor((at - origin) / chunkSeconds)),
    want: () => undefined,
    chunk: (index) => {
      let chunk = made.get(index);
      if (chunk === undefined) {
        const low = Math.max(0, index * CHUNK - GUARD);
        const high = Math.min(total, (index + 1) * CHUNK + GUARD);
        if (high <= low) return null;
        const buffer = new AudioBuffer({ length: high - low, numberOfChannels: 1, sampleRate });
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = signal(origin + (low + i) / sampleRate);
        chunk = {
          buffer,
          reversed: null,
          start: origin + low / sampleRate,
          end: origin + high / sampleRate,
        };
        made.set(index, chunk);
      }
      return chunk;
    },
    reversedOf: (chunk) => {
      let buffer = reversed.get(chunk);
      if (buffer === undefined) {
        buffer = new AudioBuffer({
          length: chunk.buffer.length,
          numberOfChannels: 1,
          sampleRate: chunk.buffer.sampleRate,
        });
        buffer.getChannelData(0).set(chunk.buffer.getChannelData(0));
        buffer.getChannelData(0).reverse();
        reversed.set(chunk, buffer);
      }
      return buffer;
    },
  };
};

/** The source second itself, scaled to stay under the clipper's knee. */
const ramp = signalSource((seconds) => seconds / 10, 8);
const level = (value: number) => signalSource(() => value, 8);
const tone = (hertz: number, sampleRate = SAMPLE_RATE) =>
  signalSource((seconds) => 0.5 * Math.sin(2 * Math.PI * hertz * seconds), 8, sampleRate);

interface ClipInput {
  readonly file: string;
  readonly start: number;
  readonly frames: number;
  readonly sourceFrame?: number;
  readonly speed?: number;
  readonly transform?: unknown;
}

const layoutOf = (
  tracks: ReadonlyArray<{
    readonly clips: ReadonlyArray<ClipInput>;
    readonly transitions?: ReadonlyArray<Record<string, unknown>>;
  }>,
): TimelineLayout => ({
  rate: RATE,
  durationFrames: Math.max(...tracks.flatMap((t) => t.clips.map((c) => c.start + c.frames))),
  tracks: tracks.map((track, trackIndex) => ({
    name: `A${trackIndex + 1}`,
    kind: "Audio" as const,
    metadata:
      track.transitions === undefined ? {} : { premiere: { transitions: track.transitions } },
    clips: track.clips.map((input, index): LaidOutClip => ({
      key: `${trackIndex}:${index}`,
      startFrame: input.start,
      endFrame: input.start + input.frames,
      clip: {
        OTIO_SCHEMA: "Clip.2",
        name: input.file,
        source_range: {
          OTIO_SCHEMA: "TimeRange.1",
          start_time: { OTIO_SCHEMA: "RationalTime.1", value: input.sourceFrame ?? 0, rate: RATE },
          duration: { OTIO_SCHEMA: "RationalTime.1", value: input.frames, rate: RATE },
        },
        ...(input.speed === undefined
          ? {}
          : {
              effects: [
                {
                  OTIO_SCHEMA: "LinearTimeWarp.1" as const,
                  name: "",
                  effect_name: "LinearTimeWarp" as const,
                  time_scalar: input.speed,
                  metadata: {},
                },
              ],
            }),
        media_references: {
          DEFAULT_MEDIA: {
            OTIO_SCHEMA: "ExternalReference.1",
            target_url: input.file,
            metadata: {},
          },
        },
        active_media_reference_key: "DEFAULT_MEDIA",
        enabled: true,
        metadata: input.transform === undefined ? {} : { stellar: { transform: input.transform } },
      },
    })),
  })),
});

interface Rendered {
  readonly samples: Float32Array;
  /** The output at a clock second. */
  readonly at: (seconds: number) => number;
  /** The largest sample between two clock seconds. */
  readonly peak: (from: number, to: number) => number;
  /** The amplitude of one frequency between two clock seconds. */
  readonly amplitude: (hertz: number, from: number, to: number) => number;
}

const render = async (input: {
  readonly layout: TimelineLayout;
  readonly files: Readonly<Record<string, AudioSource>>;
  readonly seconds: number;
  readonly play?: Partial<ConstructorParameters<typeof Transport>[0]>;
  /** Runs before rendering instead of playing, for scrub. */
  readonly drive?: (engine: AudioEngine) => void;
}): Promise<Rendered> => {
  const context = new OfflineAudioContext(1, Math.ceil(input.seconds * SAMPLE_RATE), SAMPLE_RATE);
  const engine = new AudioEngine(
    { onChange: () => undefined },
    { context, open: (url) => input.files[url] ?? null },
  );
  engine.setScene(input.layout, planTransitions(input.layout), (target) =>
    target in input.files || target === "loading.m4a" ? target : null,
  );
  if (input.drive !== undefined) input.drive(engine);
  else {
    engine.play(
      new Transport({
        t0: T0,
        frame: 0,
        speed: 1,
        rate: RATE,
        duration: input.layout.durationFrames,
        loop: null,
        stopAt: null,
        ...input.play,
      }),
    );
    // The engine extends its schedule in passes, as it does from animation frames.
    for (let at = 0.25; at < input.seconds; at += 0.25) {
      void context.suspend(at).then(() => {
        engine.pump();
        void context.resume();
      });
    }
  }
  const samples = (await context.startRendering()).getChannelData(0);
  engine.destroy();
  const index = (seconds: number) => Math.round(seconds * SAMPLE_RATE);
  return {
    samples,
    at: (seconds) => samples[index(seconds)] ?? Number.NaN,
    peak: (from, to) => {
      let peak = 0;
      for (let i = index(from); i < index(to); i++) peak = Math.max(peak, Math.abs(samples[i]!));
      return peak;
    },
    amplitude: (hertz, from, to) => {
      let real = 0;
      let imaginary = 0;
      const first = index(from);
      const count = index(to) - first;
      for (let i = 0; i < count; i++) {
        const phase = (2 * Math.PI * hertz * i) / SAMPLE_RATE;
        real += samples[first + i]! * Math.cos(phase);
        imaginary += samples[first + i]! * Math.sin(phase);
      }
      return (2 * Math.hypot(real, imaginary)) / count;
    },
  };
};

// One output sample of the ramp is this much: an offset wrong by a sample shows as this error.
const ONE_SAMPLE = 1 / SAMPLE_RATE / 10;

describe("AudioEngine", () => {
  it("starts and stops a clip on its frame, to the sample, with a short fade and no click", async () => {
    const out = await render({
      layout: layoutOf([{ clips: [{ file: "level", start: 15, frames: 30 }] }]),
      files: { level: level(0.5) },
      seconds: 2,
    });
    const start = Math.round((T0 + 0.5) * SAMPLE_RATE);
    const end = Math.round((T0 + 1.5) * SAMPLE_RATE);
    expect(out.peak(0, T0 + 0.5)).toBe(0);
    expect(out.samples[start - 1]).toBe(0);
    expect(out.samples[start + 48]).toBeGreaterThan(0.05);
    expect(out.samples[start + 288]).toBeCloseTo(0.5, 4);
    expect(out.samples[end - 288]).toBeCloseTo(0.5, 4);
    expect(Math.abs(out.samples[end]!)).toBeLessThan(1e-4);
    expect(out.peak(T0 + 1.5 + 0.001, 2)).toBe(0);
    // The fades are ramps over a few milliseconds; a click would be a step of the full 0.5.
    let step = 0;
    for (let i = 1; i < out.samples.length; i++) {
      step = Math.max(step, Math.abs(out.samples[i]! - out.samples[i - 1]!));
    }
    expect(step).toBeLessThan(0.5 / 100);
  });

  it("plays the right source second at every moment, across the join between chunks", async () => {
    // Source 2 s to 5 s runs over the chunk boundary at about 2.71 s.
    const out = await render({
      layout: layoutOf([{ clips: [{ file: "ramp", start: 0, frames: 90, sourceFrame: 60 }] }]),
      files: { ramp },
      seconds: 3.3,
    });
    let worst = 0;
    for (let t = T0 + 0.02; t < T0 + 2.98; t += 1 / SAMPLE_RATE) {
      worst = Math.max(worst, Math.abs(out.at(t) - (2 + (t - T0)) / 10));
    }
    expect(worst).toBeLessThan(1.5 * ONE_SAMPLE);
  });

  it("cuts between clips on the frame and plays each at its gain", async () => {
    const out = await render({
      layout: layoutOf([
        {
          clips: [
            { file: "300", start: 0, frames: 30 },
            { file: "500", start: 30, frames: 30, transform: { gain_db: -12 } },
          ],
        },
      ]),
      files: { "300": tone(300), "500": tone(500) },
      seconds: 2.2,
    });
    expect(out.amplitude(300, T0 + 0.1, T0 + 0.9)).toBeCloseTo(0.5, 3);
    expect(out.amplitude(500, T0 + 0.1, T0 + 0.9)).toBeLessThan(1e-3);
    expect(out.amplitude(300, T0 + 1.1, T0 + 1.9)).toBeLessThan(1e-3);
    expect(out.amplitude(500, T0 + 1.1, T0 + 1.9)).toBeCloseTo(0.5 * 10 ** (-12 / 20), 3);
  });

  it("follows volume keyframes", async () => {
    const out = await render({
      layout: layoutOf([
        {
          clips: [
            {
              file: "level",
              start: 0,
              frames: 90,
              transform: {
                keyframes: {
                  gain_db: [
                    [0.5, 0],
                    [2.5, -20],
                  ],
                },
              },
            },
          ],
        },
      ]),
      files: { level: level(0.5) },
      seconds: 3.2,
    });
    const db = (seconds: number) => 20 * Math.log10(out.at(T0 + seconds) / 0.5);
    expect(db(0.3)).toBeCloseTo(0, 2);
    expect(db(1)).toBeCloseTo(-5, 1);
    expect(db(1.5)).toBeCloseTo(-10, 1);
    expect(db(2.8)).toBeCloseTo(-20, 1);
  });

  it.each([
    ["Constant Power", Math.SQRT2],
    ["Constant Gain", 1],
    ["Exponential Fade", 0.5],
  ])("crossfades with %s over the transition's frames", async (name, middle) => {
    const out = await render({
      layout: layoutOf([
        {
          clips: [
            { file: "a", start: 0, frames: 60 },
            { file: "b", start: 60, frames: 60 },
          ],
          transitions: [{ name, startFrame: 45, endFrame: 75, cutFrame: 60 }],
        },
      ]),
      files: { a: level(0.3), b: level(0.3) },
      seconds: 4.2,
    });
    expect(out.at(T0 + 1.4)).toBeCloseTo(0.3, 4);
    // Halfway, both clips play: the outgoing one past its end, from its media's handle.
    expect(out.at(T0 + 2)).toBeCloseTo(0.3 * middle, 2);
    expect(out.at(T0 + 2.6)).toBeCloseTo(0.3, 4);
  });

  it("plays at the transport's speed, and backwards in reverse", async () => {
    const layout = layoutOf([
      { clips: [{ file: "ramp", start: 0, frames: 120, sourceFrame: 30 }] },
    ]);
    const double = await render({ layout, files: { ramp }, seconds: 2.3, play: { speed: 2 } });
    // Four seconds of source, 1 s to 5 s, in two seconds of clock.
    for (const t of [0.1, 0.7, 1.3, 1.9]) {
      expect(double.at(T0 + t)).toBeCloseTo((1 + 2 * t) / 10, 4);
    }
    expect(double.peak(T0 + 2.01, 2.3)).toBe(0);

    const back = await render({
      layout,
      files: { ramp },
      seconds: 4.3,
      play: { speed: -1, frame: 120 },
    });
    for (const t of [0.1, 1, 2.2, 3.9]) {
      expect(back.at(T0 + t)).toBeCloseTo((5 - t) / 10, 4);
    }

    const fastBack = await render({
      layout,
      files: { ramp },
      seconds: 1.3,
      play: { speed: -4, frame: 120 },
    });
    for (const t of [0.1, 0.5, 0.9]) {
      expect(fastBack.at(T0 + t)).toBeCloseTo((5 - 4 * t) / 10, 4);
    }
  });

  it("plays a sped-up clip at its speed and a reversed clip from its end", async () => {
    const out = await render({
      layout: layoutOf([
        {
          clips: [
            { file: "ramp", start: 0, frames: 30, sourceFrame: 30, speed: 2 },
            { file: "ramp", start: 30, frames: 60, sourceFrame: 30, speed: -1 },
          ],
        },
      ]),
      files: { ramp },
      seconds: 3.3,
    });
    expect(out.at(T0 + 0.5)).toBeCloseTo((1 + 2 * 0.5) / 10, 4);
    // The reversed clip's media runs 1 s to 3 s and plays from 3 s down.
    expect(out.at(T0 + 1.5)).toBeCloseTo((3 - 0.5) / 10, 4);
    expect(out.at(T0 + 2.5)).toBeCloseTo((3 - 1.5) / 10, 4);
  });

  it("loops on the frame and stops where it is told", async () => {
    const layout = layoutOf([{ clips: [{ file: "ramp", start: 0, frames: 150 }] }]);
    const looped = await render({
      layout,
      files: { ramp },
      seconds: 3.3,
      play: { frame: 30, loop: { start: 30, end: 60 } },
    });
    // Every pass of the loop plays source 1 s to 2 s.
    for (const t of [0.5, 1.5, 2.5]) expect(looped.at(T0 + t)).toBeCloseTo(0.15, 4);
    for (const t of [0.9, 1.9, 2.9]) expect(looped.at(T0 + t)).toBeCloseTo(0.19, 4);

    const stopped = await render({ layout, files: { ramp }, seconds: 2, play: { stopAt: 30 } });
    expect(stopped.at(T0 + 0.9)).toBeCloseTo(0.09, 4);
    expect(stopped.peak(T0 + 1.0005, 2)).toBe(0);
  });

  it("plays a through edit with nothing to hear at the cut", async () => {
    const out = await render({
      layout: layoutOf([
        {
          clips: [
            { file: "ramp", start: 0, frames: 30, sourceFrame: 30 },
            { file: "ramp", start: 30, frames: 30, sourceFrame: 60 },
          ],
        },
      ]),
      files: { ramp },
      seconds: 2.3,
    });
    let worst = 0;
    for (let t = T0 + 0.9; t < T0 + 1.1; t += 1 / SAMPLE_RATE) {
      worst = Math.max(worst, Math.abs(out.at(t) - (1 + (t - T0)) / 10));
    }
    expect(worst).toBeLessThan(1.5 * ONE_SAMPLE);
  });

  it("resamples a 44.1 kHz source and joins its chunks without a click", async () => {
    // The chunk boundary of a 44.1 kHz file is at about 2.95 s of source.
    const out = await render({
      layout: layoutOf([{ clips: [{ file: "tone", start: 0, frames: 60, sourceFrame: 60 }] }]),
      files: { tone: tone(440, 44100) },
      seconds: 2.3,
    });
    let worst = 0;
    for (let t = T0 + 0.02; t < T0 + 1.98; t += 1 / SAMPLE_RATE) {
      const ideal = 0.5 * Math.sin(2 * Math.PI * 440 * (2 + (t - T0)));
      worst = Math.max(worst, Math.abs(out.at(t) - ideal));
    }
    expect(worst).toBeLessThan(0.01);
  });

  it("keeps a mix over full scale from clipping and leaves a quiet one untouched", async () => {
    const stacked = (file: string) => ({ clips: [{ file, start: 0, frames: 30 }] });
    const loud = await render({
      layout: layoutOf([stacked("level"), stacked("level"), stacked("level")]),
      files: { level: level(0.8) },
      seconds: 1.3,
    });
    expect(loud.at(T0 + 0.5)).toBeGreaterThan(0.95);
    expect(loud.peak(0, 1.3)).toBeLessThanOrEqual(1);
    const quiet = await render({
      layout: layoutOf([stacked("level"), stacked("level")]),
      files: { level: level(0.4) },
      seconds: 1.3,
    });
    expect(quiet.at(T0 + 0.5)).toBeCloseTo(0.8, 5);
  });

  it("plays the clips that have sound when another has none yet", async () => {
    const out = await render({
      layout: layoutOf([
        { clips: [{ file: "level", start: 0, frames: 30 }] },
        { clips: [{ file: "building.wav", start: 0, frames: 30 }] },
        { clips: [{ file: "loading.m4a", start: 0, frames: 30 }] },
      ]),
      files: { level: level(0.5) },
      seconds: 1.3,
    });
    expect(out.at(T0 + 0.5)).toBeCloseTo(0.5, 4);
  });

  it("plays a moment of the clip under the playhead on a scrub, forwards or backwards", async () => {
    const layout = layoutOf([{ clips: [{ file: "ramp", start: 0, frames: 150 }] }]);
    const forward = await render({
      layout,
      files: { ramp },
      seconds: 0.2,
      drive: (engine) => engine.scrub(60, 1),
    });
    // Frame 60 is source 2 s; the snippet starts 12 ms in and runs 60 ms.
    expect(forward.at(0.012 + 0.03)).toBeCloseTo((2 + 0.03) / 10, 4);
    expect(forward.peak(0.08, 0.2)).toBe(0);
    const backward = await render({
      layout,
      files: { ramp },
      seconds: 0.2,
      drive: (engine) => engine.scrub(60, -1),
    });
    expect(backward.at(0.012 + 0.03)).toBeCloseTo((2 - 0.03) / 10, 4);
    const off = await render({
      layout,
      files: { ramp },
      seconds: 0.2,
      drive: (engine) => {
        engine.scrubEnabled = false;
        engine.scrub(60, 1);
      },
    });
    expect(off.peak(0, 0.2)).toBe(0);
  });
});
