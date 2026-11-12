import type { TimelineLayout } from "@t3tools/timeline/layout";

import { audioFile, type DecodedChunk, onAudioReady } from "./audioCache";
import { OriginalSound } from "./audioOriginals";
import {
  type ChunkGrid,
  type ClipAudio,
  clampSpan,
  emptyLeg,
  emptySegment,
  emptySpan,
  levelAt,
  levelMoves,
  planClipAudio,
  segmentAt,
  type Transport,
  type VoiceSpan,
  voiceSpan,
} from "./audioSchedule";
import type { ClipTransitions } from "./transitions";

/**
 * Timeline sound through the Web Audio API: decoded chunks of each clip are started at exact
 * context times against the transport the picture reads. They are scheduled seconds ahead and
 * levels are drawn as ramps, so a busy main thread delays the next pass, not what is playing.
 */

/** What the engine plays a clip's sound from. `AudioFile` in the app; a tone in tests. */
export interface AudioSource {
  readonly grid: ChunkGrid;
  readonly start: number;
  readonly end: number;
  readonly chunk: (index: number) => DecodedChunk | null;
  readonly reversedOf: (chunk: DecodedChunk) => AudioBuffer;
  readonly chunkAt: (seconds: number) => number;
  readonly want: (from: number, decodeTo: number, fetchTo?: number) => void;
}

export type AudioState =
  /** No sound yet: nothing has asked for it, or the browser has no audio output. */
  | "off"
  | "running"
  /** The browser is holding sound back until the user clicks or presses a key. */
  | "blocked";

export interface AudioStatus {
  readonly state: AudioState;
  /** Clips at the playhead with no sound to play: their audio is still being prepared. */
  readonly silent: number;
  /** Clips at the playhead playing from their original file until their rendition exists. */
  readonly original: number;
}

// Buffers are started this far ahead of the context's clock: past the second between
// animation frames that a browser allows a window it has covered or throttled.
const AHEAD_SECONDS = 2.5;
// A pass runs once this much of that has played.
const PASS_SECONDS = 0.25;
// Shuttling fast, the same reach in source would decode many chunks a clip, so it shortens
// with the speed, down to this.
const MIN_AHEAD_SECONDS = 0.6;
// Levels that move are drawn as a ramp to a new point this often.
const LEVEL_STEP_SECONDS = 0.005;
// A run of playback fades in and out over this long, so starting or stopping inside a clip
// does not click.
const RUN_FADE_SECONDS = 0.005;
// Files of clips this many seconds ahead are opened and their first chunk decoded.
const WARM_SECONDS = 3;
// Playing, this much sound past the playhead is kept on its way, and this many chunks decoded.
const READ_AHEAD_SECONDS = 10;
const DECODE_AHEAD_CHUNKS = 2;
// A transport starts this much later than the earliest a buffer could, so its first buffers
// are still on time after the script that starts them has run.
const START_MARGIN_SECONDS = 0.008;
// A step or a drag of the playhead plays this much of every clip under it.
const SCRUB_SECONDS = 0.06;
const SCRUB_FADE_SECONDS = 0.004;
// The mix may run this far over full scale before the clipper flattens it.
const HEADROOM = 4;
const KNEE = 0.85;
// How often the audio clock is compared with the page's, to place the picture.
const CLOCK_SAMPLE_MS = 200;
const CLOCK_SNAP_SECONDS = 0.02;
// An output timestamp that puts the speakers further than this from the context is stale.
const MAX_OUTPUT_LATENCY_SECONDS = 0.5;
const MAX_CLOCK_LEAD_SECONDS = 0.05;
const BLOCKED_AFTER_MS = 400;
// A context with nothing to play is suspended after this long, which lets the device sleep.
const IDLE_SUSPEND_MS = 20_000;

/** Passes anything under the knee untouched and bends what is over it toward full scale. */
const clipCurve = () => {
  const points = 8193;
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const amplitude = ((i / (points - 1)) * 2 - 1) * HEADROOM;
    const size = Math.abs(amplitude);
    const shaped = size <= KNEE ? size : KNEE + (1 - KNEE) * Math.tanh((size - KNEE) / (1 - KNEE));
    curve[i] = Math.sign(amplitude) * shaped;
  }
  return curve;
};

interface Voice {
  readonly plan: ClipAudio;
  readonly span: VoiceSpan;
  readonly gain: GainNode;
  source: AudioSource | null;
  /** The clock time up to which buffers are started, and levels drawn. */
  cursor: number;
  levelCursor: number;
  ramping: boolean;
  /** Nothing of the clip falls inside its file on this leg. */
  dead: boolean;
}

interface Playing {
  readonly node: AudioBufferSourceNode;
  readonly end: number;
}

interface Run {
  readonly transport: Transport;
  readonly gain: GainNode;
  /** By leg, then by clip. */
  readonly legs: Map<number, Map<ClipAudio, Voice>>;
  readonly playing: Array<Playing>;
  /** Fades are in place for the joins up to this leg, and for the end. */
  joined: number;
  ended: boolean;
}

interface Graph {
  readonly context: BaseAudioContext;
  readonly bus: GainNode;
  readonly output: GainNode;
  readonly meters: readonly [AnalyserNode, AnalyserNode];
}

export class AudioEngine {
  private graph: Graph | null = null;
  /** The context when it plays to a device; null in an offline render. */
  private live: AudioContext | null = null;
  private plans: ReadonlyArray<ClipAudio> = [];
  private rate = 30;
  private urls: (target: string) => string | null = () => null;
  private originalUrls: (target: string) => string | null = () => null;
  /** The clips with an original to play and no rendition, by where they come in. */
  private originalPlans: ReadonlyArray<ClipAudio> = [];
  private originals: OriginalSound | null = null;
  private silentVoices = 0;
  private run: Run | null = null;
  private scheduledTo = 0;
  private ahead = AHEAD_SECONDS;
  private dirty = false;
  private clockOffset = Number.NaN;
  private clockSampledAt = 0;
  private wasRunning = false;
  private epochNumber = 0;
  private status: AudioStatus = { state: "off", silent: 0, original: 0 };
  private wantedAt = Number.NaN;
  private scrubbing: {
    readonly gain: GainNode;
    readonly nodes: Array<AudioBufferSourceNode>;
  } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly leg = emptyLeg();
  private readonly segment = emptySegment();
  private readonly scratch = emptySpan();
  private readonly meterData = new Float32Array(1024);
  private readonly stopListening: () => void;
  scrubEnabled = true;

  constructor(
    private readonly listener: {
      /** Something changed that the next animation frame should look at. */
      readonly onChange: () => void;
      readonly onStatus?: (status: AudioStatus) => void;
    },
    private readonly options: {
      /** Render into this context instead of opening the device: an offline render. */
      readonly context?: BaseAudioContext;
      readonly open?: (url: string) => AudioSource | null;
    } = {},
  ) {
    this.stopListening = onAudioReady(() => {
      this.dirty = true;
      this.listener.onChange();
    });
    if (options.context !== undefined) this.build(options.context);
    navigator.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
  }

  private readonly onDeviceChange = () => {
    // The new device has its own latency; measure again rather than ease toward it.
    this.clockOffset = Number.NaN;
    this.listener.onChange();
  };

  private readonly onStateChange = () => {
    this.refreshStatus();
    this.listener.onChange();
  };

  private build(context: BaseAudioContext) {
    const bus = new GainNode(context);
    const drive = new GainNode(context, { gain: 1 / HEADROOM });
    const clipper = new WaveShaperNode(context, { curve: clipCurve() });
    const output = new GainNode(context);
    bus.connect(drive).connect(clipper).connect(output).connect(context.destination);
    const split = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
    const upmix = new GainNode(context, {
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    output.connect(upmix).connect(split);
    const meters = [
      new AnalyserNode(context, { fftSize: 1024 }),
      new AnalyserNode(context, { fftSize: 1024 }),
    ] as const;
    split.connect(meters[0], 0);
    split.connect(meters[1], 1);
    this.graph = { context, bus, output, meters };
    return this.graph;
  }

  /**
   * Makes sound possible: opens the device on first use and wakes a context the browser or the
   * idle timer put to sleep. Browsers only allow this inside a click or a key press.
   */
  unlock() {
    if (this.options.context !== undefined) return;
    if (Number.isNaN(this.wantedAt)) {
      this.wantedAt = performance.now();
      // A context takes a moment to start; only one still held back after that is blocked.
      setTimeout(() => this.refreshStatus(), BLOCKED_AFTER_MS + 50);
    }
    if (this.live === null) {
      try {
        // 48 kHz is what the proxy build encodes, so buffers play without resampling.
        const context = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
        context.addEventListener("statechange", this.onStateChange);
        this.live = context;
        this.originals = new OriginalSound(context, this.build(context).bus);
      } catch {
        this.live = null;
        this.graph = null;
      }
    }
    if (this.live !== null && this.live.state !== "running" && this.live.state !== "closed") {
      void this.live.resume().catch(() => undefined);
    }
    this.restIdle();
    this.refreshStatus();
  }

  private restIdle() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.live === null || this.run !== null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.run === null && this.live?.state === "running") {
        this.wantedAt = Number.NaN;
        void this.live.suspend().catch(() => undefined);
      }
    }, IDLE_SUSPEND_MS);
  }

  private get running() {
    return this.graph !== null && (this.live === null || this.live.state === "running");
  }

  /** Bumps when the clock changes hands between the audio device and the page. */
  get epoch() {
    return this.epochNumber;
  }

  private refreshStatus() {
    const silent = this.silentVoices + (this.originals?.silent ?? 0);
    const original = this.originals?.heard ?? 0;
    const state: AudioState =
      this.live === null
        ? "off"
        : this.live.state === "running"
          ? "running"
          : performance.now() - this.wantedAt > BLOCKED_AFTER_MS
            ? "blocked"
            : "off";
    const { status } = this;
    if (state === status.state && silent === status.silent && original === status.original) return;
    this.status = { state, silent, original };
    this.listener.onStatus?.(this.status);
  }

  get currentStatus() {
    return this.status;
  }

  /**
   * `urls` gives a clip's rendition and `originals` the file itself, by the clip's target;
   * the original is played only while there is no rendition.
   */
  setScene(
    layout: TimelineLayout,
    transitions: ReadonlyMap<string, ClipTransitions>,
    urls: (target: string) => string | null,
    originals: (target: string) => string | null = () => null,
  ) {
    this.plans = planClipAudio(layout, transitions);
    this.rate = layout.rate;
    this.setUrls(urls, originals);
  }

  /** New signed URLs or freshly built renditions for the same timeline. */
  setUrls(
    urls: (target: string) => string | null,
    originals: (target: string) => string | null = () => null,
  ) {
    this.urls = urls;
    this.originalUrls = originals;
    this.originalPlans = this.plans
      .filter((plan) => urls(plan.target) === null && originals(plan.target) !== null)
      .toSorted((a, b) => a.from - b.from);
    this.dirty = true;
  }

  /** Steers the clips playing from originals to `frame`, moving `fps` frames a second. */
  private followOriginals(frame: number, fps: number) {
    const originals = this.originals;
    if (originals === null || (this.originalPlans.length === 0 && !originals.loaded)) return;
    originals.sync(this.originalPlans, this.originalUrls, frame, fps, this.rate);
    this.refreshStatus();
  }

  /**
   * The clock the transport runs on, in seconds, at the page time `now`: the time of the sound
   * leaving the speakers while audio runs, so the picture is placed against what is heard, and
   * the page's own clock otherwise, so a timeline plays on with no sound.
   */
  clock(now: number): number {
    const live = this.live;
    const running = live !== null && live.state === "running";
    if (running !== this.wasRunning) {
      this.wasRunning = running;
      this.clockOffset = Number.NaN;
      this.epochNumber += 1;
    }
    if (!running || live === null) return now / 1000;
    if (Number.isNaN(this.clockOffset) || now - this.clockSampledAt >= CLOCK_SAMPLE_MS) {
      this.clockSampledAt = now;
      // Sound leaves the speakers one output latency after the context renders it. The output
      // timestamp says exactly when; it is stale just after a context starts or wakes, and
      // then, or where a browser has none, the latency the device reports stands in.
      const stamp = live.getOutputTimestamp?.();
      const behind =
        stamp?.contextTime === undefined || stamp.performanceTime === undefined
          ? Number.NaN
          : live.currentTime -
            (stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000);
      const latency =
        behind > -MAX_CLOCK_LEAD_SECONDS && behind < MAX_OUTPUT_LATENCY_SECONDS
          ? behind
          : live.outputLatency || live.baseLatency || 0;
      const measured = live.currentTime - latency - performance.now() / 1000;
      // Small differences are measurement noise and are eased in; a large one is a real
      // change (the device, a stall) and is taken at once.
      this.clockOffset =
        Number.isNaN(this.clockOffset) || Math.abs(measured - this.clockOffset) > CLOCK_SNAP_SECONDS
          ? measured
          : this.clockOffset + (measured - this.clockOffset) * 0.1;
    }
    return now / 1000 + this.clockOffset;
  }

  /** The earliest clock time new sound can start, for a transport about to be made. */
  startTime(now: number): number {
    const live = this.live;
    if (live === null || live.state !== "running") return now / 1000;
    return live.currentTime + this.lead() + START_MARGIN_SECONDS;
  }

  /** How far ahead of the context's clock a buffer has to be started to play on time. */
  private lead() {
    return (this.live?.baseLatency ?? 0) + 0.012;
  }

  /** Starts playing along `transport`; what was playing fades out as it comes in. */
  play(transport: Transport) {
    const graph = this.graph;
    this.stopRun(this.running ? transport.t0 : 0);
    this.stopScrub();
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (graph === null || !this.running) return;
    const gain = new GainNode(graph.context, { gain: 0 });
    gain.connect(graph.bus);
    gain.gain.setValueAtTime(0, transport.t0);
    gain.gain.linearRampToValueAtTime(1, transport.t0 + RUN_FADE_SECONDS);
    this.run = { transport, gain, legs: new Map(), playing: [], joined: 0, ended: false };
    this.scheduledTo = 0;
    this.pass();
  }

  stop() {
    this.stopRun(0);
    this.originals?.pause();
    this.silentVoices = 0;
    this.restIdle();
    this.refreshStatus();
  }

  private stopRun(at: number) {
    const run = this.run;
    const graph = this.graph;
    this.run = null;
    if (run === null || graph === null) return;
    const now = graph.context.currentTime;
    const from = Math.max(now, at - RUN_FADE_SECONDS);
    const level = run.gain.gain;
    level.cancelScheduledValues(from);
    level.setValueAtTime(1, from);
    level.linearRampToValueAtTime(0, from + RUN_FADE_SECONDS);
    for (const { node } of run.playing) {
      try {
        node.stop(from + RUN_FADE_SECONDS);
      } catch {
        // Already ended.
      }
    }
    // Disconnected once it is silent; nothing on the animation frame waits for this.
    setTimeout(() => run.gain.disconnect(), (from - now + RUN_FADE_SECONDS) * 1000 + 100);
  }

  /** Called every animation frame while playing; runs a pass when one is due. */
  pump() {
    const graph = this.graph;
    const run = this.run;
    if (graph === null || run === null) return;
    // What the context renders now is the frame an element has to be on now.
    this.followOriginals(run.transport.frameAt(graph.context.currentTime), run.transport.fps);
    if (!this.dirty && this.scheduledTo - graph.context.currentTime > this.ahead - PASS_SECONDS) {
      return;
    }
    this.pass();
  }

  private open(url: string): AudioSource | null {
    return this.options.open === undefined ? audioFile(url) : this.options.open(url);
  }

  /** Starts every buffer and draws every level due in the next stretch of clock time. */
  private pass() {
    const graph = this.graph;
    const run = this.run;
    if (graph === null || run === null) return;
    this.dirty = false;
    const { context } = graph;
    const now = context.currentTime;
    const { transport } = run;
    this.ahead = Math.max(
      MIN_AHEAD_SECONDS,
      AHEAD_SECONDS / Math.max(1, Math.abs(transport.fps) / this.rate),
    );
    const horizon = now + this.ahead;
    this.scheduledTo = horizon;
    const warm = WARM_SECONDS * Math.abs(transport.fps);
    const firstLeg = transport.legIndexAt(now);
    const lastLeg = transport.legIndexAt(horizon);
    let silent = 0;
    for (let index = firstLeg; index <= lastLeg; index++) {
      const leg = transport.leg(index, this.leg);
      if (leg.t1 <= leg.t0) continue;
      this.fadeJoins(run, index, leg.t0, horizon);
      const forward = leg.f1 >= leg.f0;
      const fps = (leg.f1 - leg.f0) / (leg.t1 - leg.t0);
      const reached = leg.f0 + (Math.min(horizon, leg.t1) - leg.t0) * fps;
      const passed = leg.f0 + (Math.max(now, leg.t0) - leg.t0) * fps;
      const low = Math.min(reached, passed);
      const high = Math.max(reached, passed);
      let voices = run.legs.get(index);
      for (const plan of this.plans) {
        if (plan.to <= low || plan.from >= high) {
          // Not yet in reach: have its file open and its first chunk decoded for the cut.
          const entry = forward ? plan.from : plan.to;
          if (forward ? entry >= high && entry < high + warm : entry <= low && entry > low - warm) {
            this.prepare(plan, entry, forward ? 1 : -1);
          }
          continue;
        }
        if (voices === undefined) {
          voices = new Map();
          run.legs.set(index, voices);
        }
        let voice = voices.get(plan);
        if (voice === undefined) {
          const span = voiceSpan(plan, leg, this.rate);
          if (span === null) continue;
          const gain = new GainNode(context, { gain: 0 });
          gain.connect(run.gain);
          voice = {
            plan,
            span,
            gain,
            source: null,
            cursor: span.tA,
            levelCursor: span.tA,
            ramping: false,
            dead: false,
          };
          voices.set(plan, voice);
        }
        if (this.feed(run, voice, now, horizon)) continue;
        // A clip with an original to play is counted by what plays it.
        if (this.originals === null || this.originalUrls(plan.target) === null) silent += 1;
      }
    }
    this.finish(run, horizon);
    this.sweep(run, firstLeg, now);
    this.silentVoices = silent;
    this.refreshStatus();
  }

  /** Fades the run out and back in where one leg hands over to the next: a loop's jump. */
  private fadeJoins(run: Run, index: number, start: number, horizon: number) {
    if (index === 0 || index <= run.joined || start - RUN_FADE_SECONDS > horizon) return;
    run.joined = index;
    const level = run.gain.gain;
    level.setValueAtTime(1, start - RUN_FADE_SECONDS);
    level.linearRampToValueAtTime(0, start);
    level.linearRampToValueAtTime(1, start + RUN_FADE_SECONDS);
  }

  /** Fades the run out where playback ends by itself. */
  private finish(run: Run, horizon: number) {
    const end = run.transport.endsAt;
    if (run.ended || end > horizon) return;
    run.ended = true;
    const level = run.gain.gain;
    level.setValueAtTime(1, Math.max(run.transport.t0 + RUN_FADE_SECONDS, end - RUN_FADE_SECONDS));
    level.linearRampToValueAtTime(0, end);
  }

  /** Lets go of buffers that have played and voices that are over. */
  private sweep(run: Run, firstLeg: number, now: number) {
    const { playing } = run;
    let kept = 0;
    for (const entry of playing) {
      if (entry.end > now) playing[kept++] = entry;
    }
    playing.length = kept;
    for (const [index, voices] of run.legs) {
      for (const [plan, voice] of voices) {
        if (voice.span.tB > now - 0.5) continue;
        voice.gain.disconnect();
        voices.delete(plan);
      }
      if (index < firstLeg && voices.size === 0) run.legs.delete(index);
    }
  }

  /** The source second a clip plays at a timeline frame. */
  private sourceAt(plan: ClipAudio, frame: number) {
    return plan.sourceAtStart + ((frame - plan.startFrame) / this.rate) * plan.scalar;
  }

  /** Opens an upcoming clip's file and decodes the chunk it comes in on. */
  private prepare(plan: ClipAudio, frame: number, direction: number) {
    const url = this.urls(plan.target);
    const source = url === null ? null : this.open(url);
    if (source === null) return;
    const heading = direction * Math.sign(plan.scalar);
    const seconds = this.sourceAt(plan, frame);
    const chunk = source.chunkAt(heading > 0 ? seconds : seconds - 1e-6);
    source.want(chunk, chunk + heading);
  }

  /** Extends one voice to the horizon. False when the clip has no rendition to play from. */
  private feed(run: Run, voice: Voice, now: number, horizon: number): boolean {
    if (voice.dead) return true;
    const { span, plan } = voice;
    if (voice.source === null) {
      const url = this.urls(plan.target);
      if (url === null) return false;
      const source = this.open(url);
      if (source === null) return true;
      voice.source = source;
      if (!clampSpan(span, source.start, source.end)) {
        voice.dead = true;
        return true;
      }
      // A file that opened late leaves the part already past unplayed.
      const from = Math.max(span.tA, now);
      voice.cursor = from;
      voice.levelCursor = from;
      const frame = span.fA + (from - span.tA) * span.fps;
      voice.gain.gain.setValueAtTime(levelAt(plan, frame, this.rate), from);
      voice.ramping = false;
    }
    const source = voice.source;
    const graph = this.graph;
    if (graph === null) return true;
    this.drawLevel(voice, horizon);

    const until = Math.min(horizon, span.tB) - 1e-6;
    const lead = this.lead();
    const speed = Math.abs(span.m);
    const heading = span.m > 0 ? 1 : -1;
    while (voice.cursor < until) {
      let t = voice.cursor;
      const late = t < now + lead;
      if (late) {
        t = now + lead;
        if (t >= span.tB) {
          voice.cursor = span.tB;
          break;
        }
      }
      const segment = segmentAt(span, source.grid, t, this.segment);
      const chunk = source.chunk(segment.chunk);
      if (chunk === null) {
        source.want(segment.chunk, segment.chunk + heading * DECODE_AHEAD_CHUNKS);
        // What can no longer play on time is skipped; the rest starts when the chunk lands.
        if (late) voice.cursor = t;
        break;
      }
      this.start(
        run,
        voice.gain,
        source,
        chunk,
        segment.reversed,
        segment.from,
        segment.length,
        speed,
        segment.when,
        segment.fadeIn || late,
        segment.fadeOut,
      );
      voice.cursor = segment.next;
    }
    // Keep the sound ahead of the playhead on its way.
    const at = span.sA + (Math.max(voice.cursor, now) - span.tA) * span.m;
    const here = source.chunkAt(heading > 0 ? at : at - 1e-6);
    source.want(
      here,
      here + heading * DECODE_AHEAD_CHUNKS,
      source.chunkAt(at + heading * READ_AHEAD_SECONDS * Math.max(1, speed)),
    );
    return true;
  }

  /**
   * Starts one stretch of a chunk at an exact context time. Starts and offsets land on whole
   * samples, so buffers that follow each other at normal speed line up to the sample.
   */
  private start(
    run: { readonly playing: Array<Playing> } | null,
    into: AudioNode,
    source: AudioSource,
    chunk: DecodedChunk,
    reversed: boolean,
    from: number,
    length: number,
    speed: number,
    when: number,
    fadeIn: boolean,
    fadeOut: boolean,
  ): AudioBufferSourceNode | null {
    const graph = this.graph;
    if (graph === null) return null;
    const { context } = graph;
    const buffer = reversed ? source.reversedOf(chunk) : chunk.buffer;
    let offset = reversed ? chunk.end - from : from - chunk.start;
    let starts = when;
    let plays = length;
    if (offset < 0) {
      starts -= offset / speed;
      plays += offset;
      offset = 0;
    }
    offset = Math.round(offset * buffer.sampleRate) / buffer.sampleRate;
    plays = Math.min(plays, buffer.duration - offset);
    if (plays <= 0) return null;
    starts = Math.round(starts * context.sampleRate) / context.sampleRate;
    const node = new AudioBufferSourceNode(context, { buffer, playbackRate: speed });
    const ends = starts + plays / speed;
    if (fadeIn || fadeOut) {
      const fade = Math.min(source.grid.guardSeconds / speed, (ends - starts) / 2);
      const envelope = new GainNode(context, { gain: fadeIn ? 0 : 1 });
      if (fadeIn) {
        envelope.gain.setValueAtTime(0, starts);
        envelope.gain.linearRampToValueAtTime(1, starts + fade);
      }
      if (fadeOut) {
        envelope.gain.setValueAtTime(1, ends - fade);
        envelope.gain.linearRampToValueAtTime(0, ends);
      }
      node.connect(envelope).connect(into);
    } else {
      node.connect(into);
    }
    node.start(starts, offset, plays);
    run?.playing.push({ node, end: ends });
    return node;
  }

  /** Draws a voice's level up to `horizon`: one value where it rests, ramps where it moves. */
  private drawLevel(voice: Voice, horizon: number) {
    const { span, plan } = voice;
    const level = voice.gain.gain;
    const end = Math.min(horizon, span.tB);
    let t = voice.levelCursor;
    while (t < end) {
      const next = Math.min(t + LEVEL_STEP_SECONDS, span.tB);
      const before = span.fA + (t - span.tA) * span.fps;
      const after = span.fA + (next - span.tA) * span.fps;
      // A fade shorter than a step still has one end inside it.
      const moves = levelMoves(plan, before, this.rate) || levelMoves(plan, after, this.rate);
      if (moves) {
        if (!voice.ramping) level.setValueAtTime(levelAt(plan, before, this.rate), t);
        level.linearRampToValueAtTime(levelAt(plan, after, this.rate), next);
      }
      voice.ramping = moves;
      t = next;
    }
    voice.levelCursor = t;
  }

  /** Paused: has the sound under and just past the playhead decoded, so play starts at once. */
  prime(frame: number) {
    this.followOriginals(frame, 0);
    const warm = WARM_SECONDS * this.rate;
    for (const plan of this.plans) {
      if (plan.to <= frame || plan.from > frame + warm) continue;
      this.prepare(plan, Math.max(frame, plan.from), 1);
    }
  }

  /**
   * Plays a moment of every clip under `frame`, as an editor does when the playhead is
   * stepped or dragged. `direction` is which way it moved; backwards plays the moment before.
   */
  scrub(frame: number, direction: number) {
    const graph = this.graph;
    if (!this.scrubEnabled || graph === null || !this.running || this.run !== null) return;
    this.stopScrub();
    this.restIdle();
    const { context } = graph;
    const when = context.currentTime + this.lead();
    const gain = new GainNode(context, { gain: 0 });
    gain.connect(graph.bus);
    const nodes: Array<AudioBufferSourceNode> = [];
    for (const plan of this.plans) {
      if (plan.from > frame || frame >= plan.to || nodes.length >= 8) continue;
      const url = this.urls(plan.target);
      const source = url === null ? null : this.open(url);
      if (source === null) continue;
      const heading = (direction < 0 ? -1 : 1) * Math.sign(plan.scalar);
      const speed = Math.abs(plan.scalar);
      const seconds = Math.min(source.end, Math.max(source.start, this.sourceAt(plan, frame)));
      const index = source.chunkAt(heading > 0 ? seconds : seconds - 1e-6);
      const chunk = source.chunk(index);
      if (chunk === null) {
        source.want(index, index + heading);
        continue;
      }
      const level = new GainNode(context, { gain: levelAt(plan, frame, this.rate) });
      level.connect(gain);
      const node = this.start(
        null,
        level,
        source,
        chunk,
        heading < 0,
        seconds,
        SCRUB_SECONDS * speed,
        speed,
        when,
        false,
        false,
      );
      if (node !== null) nodes.push(node);
    }
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(1, when + SCRUB_FADE_SECONDS);
    gain.gain.setValueAtTime(1, when + SCRUB_SECONDS - SCRUB_FADE_SECONDS);
    gain.gain.linearRampToValueAtTime(0, when + SCRUB_SECONDS);
    this.scrubbing = { gain, nodes };
  }

  private stopScrub() {
    const scrubbing = this.scrubbing;
    const graph = this.graph;
    this.scrubbing = null;
    if (scrubbing === null || graph === null) return;
    const now = graph.context.currentTime;
    const level = scrubbing.gain.gain;
    level.cancelScheduledValues(now);
    level.setTargetAtTime(0, now, SCRUB_FADE_SECONDS / 3);
    for (const node of scrubbing.nodes) {
      try {
        node.stop(now + SCRUB_FADE_SECONDS * 2);
      } catch {
        // Already ended.
      }
    }
    setTimeout(() => scrubbing.gain.disconnect(), 200);
  }

  /** The peak of each channel over the last 20 ms, into `levels` as [left, right]. */
  readLevels(levels: Float32Array) {
    const graph = this.graph;
    for (let channel = 0; channel < 2; channel++) {
      let peak = 0;
      if (graph !== null && this.running) {
        graph.meters[channel]!.getFloatTimeDomainData(this.meterData);
        for (const value of this.meterData) {
          const size = value < 0 ? -value : value;
          if (size > peak) peak = size;
        }
      }
      levels[channel] = peak;
    }
  }

  /** The context and the node everything is heard through, for measurement. */
  probe(): { readonly context: BaseAudioContext; readonly output: AudioNode } | null {
    return this.graph === null ? null : { context: this.graph.context, output: this.graph.output };
  }

  destroy() {
    this.stopRun(0);
    this.stopScrub();
    this.stopListening();
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
    this.originals?.destroy();
    this.originals = null;
    this.live?.removeEventListener("statechange", this.onStateChange);
    void this.live?.close().catch(() => undefined);
    this.live = null;
    this.graph = null;
  }
}
