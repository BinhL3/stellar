import type { LaidOutClip, LaidOutTrack, TimelineLayout } from "@t3tools/timeline/layout";
import { timeScalarOf } from "@t3tools/timeline/speed";

import { observeResize } from "~/lib/observeResize";

import { AudioEngine, type AudioStatus } from "./audioEngine";
import { Transport } from "./audioSchedule";
import { ClipDecoder, loadProxy, prefetchProxies, webCodecsAvailable } from "./clipDecoder";

import {
  type ClipPose,
  clipOffset,
  clipSourceAt,
  emptyPose,
  graphicOf,
  graphicText,
  graphicTextPosition,
  poseAt,
  transformOf,
} from "./clipTransform";
import { CANVAS_BLEND, clipNotDrawn } from "./notDrawn";
import { layoutText, paintText, type TextLayout } from "./textPainter";
import {
  type ClipTransitions,
  emptyMix,
  mixAt,
  planTransitions,
  type TransitionMix,
  windowEnd,
  windowStart,
} from "./transitions";

/** What the engine plays for one media file; URLs are null when unavailable. */
export interface PreviewSource {
  readonly video: string | null;
  readonly audio: string | null;
  /** `audio` is a Stellar rendition (AAC by itself in MP4), which is what the engine plays. */
  readonly audioProxy?: boolean;
  readonly still: string | null;
  /** `video` is a Stellar proxy (single H.264 track), which decodes through WebCodecs. */
  readonly videoProxy?: boolean;
  /** The original's display size; proxies are smaller, but Premiere's Scale is relative to this. */
  readonly width?: number;
  readonly height?: number;
}

export interface PreviewScene {
  readonly layout: TimelineLayout;
  readonly frame: { readonly width: number; readonly height: number };
  readonly sources: ReadonlyMap<string, PreviewSource>;
}

// Clips this close to the playhead, either side, keep a decoder warm so cuts never flash.
// 3 s gives a fresh decoder time to open its file on a slow drive and buffer before the cut.
const WARM_SECONDS = 3;
// Stills decode off the main thread, shrunk to at most this long edge: full-size PNGs (article
// screenshots, emoji) otherwise decode synchronously on first draw, a visible freeze.
const STILL_MAX_EDGE = 1600;
// Scrubbing waits this long for every layer's exact frame, then draws what it has; layers that
// are still decoding show their last picture, so a fast scrub keeps moving instead of freezing.
const MAX_HOLD_MS = 50;

interface StillImage {
  bitmap: ImageBitmap | null;
  /** The original's size, which Premiere's Scale is relative to. */
  width: number;
  height: number;
}
// Playing clips follow the clock by speeding up or slowing down at most this much; only past
// RESYNC_SECONDS do they seek, because a seek flushes the decoder and stalls that clip.
const MAX_NUDGE = 0.08;
const RESYNC_SECONDS = 0.5;
// The picture ignores a backward correction of the audio clock smaller than this.
const CLOCK_SLACK_SECONDS = 0.25;
// The level meter keeps drawing this long after sound stops, to fall back to rest.
const METER_REST_MS = 700;

interface VideoSlot {
  readonly element: HTMLVideoElement;
  readonly url: string;
  /** Source seconds the slot last seeked to while paused, so it doesn't re-seek each tick. */
  wanted: number;
  /** The file failed to load; it draws as offline instead of holding the picture forever. */
  failed: boolean;
}

// Rates move in steps, so an element is not handed a new one every frame.
const RATE_STEP = 0.01;
// Upcoming clips start playing this early, silent and unseen, so they're running at the cut;
// starting a paused element takes 50-200 ms, a visible hitch on every cut otherwise.
const PREROLL_SECONDS = 0.3;

const setRate = (element: HTMLMediaElement, rate: number) => {
  const stepped = Math.round(rate / RATE_STEP) * RATE_STEP;
  if (Math.abs(element.playbackRate - stepped) >= RATE_STEP / 2) element.playbackRate = stepped;
};

/** Steers a playing element toward `target` seconds without seeking unless it is far off. */
const follow = (element: HTMLMediaElement, target: number, speed: number) => {
  const drift = element.currentTime - target;
  if (Math.abs(drift) > RESYNC_SECONDS) {
    element.currentTime = target;
    setRate(element, speed);
    return;
  }
  // Inside a frame of drift, play at speed; past it, lean toward the target.
  const nudge = Math.abs(drift) < 0.02 ? 0 : Math.min(MAX_NUDGE, Math.max(-MAX_NUDGE, drift * 2));
  setRate(element, speed * (1 - nudge));
};

/**
 * Where an upcoming clip's media should be now so it reaches `first`, the source second it
 * opens on, exactly when it comes in `untilFrames` from now; null when that is too far off or
 * the clip opens on its media's very beginning. `mediaSpeed` is the transport's speed times
 * the clip's own.
 */
const prerollTarget = (
  first: number,
  untilFrames: number,
  rate: number,
  speed: number,
  mediaSpeed: number,
) => {
  const until = untilFrames / rate / speed;
  if (until > PREROLL_SECONDS || until <= 0) return null;
  const target = first - until * mediaSpeed;
  return target < 0 ? null : target;
};

/** Where an upcoming clip waits while playing: its pre-roll start, so starting it needs no seek. */
const parkTarget = (first: number, mediaSpeed: number) =>
  first - PREROLL_SECONDS * mediaSpeed >= 0 ? first - PREROLL_SECONDS * mediaSpeed : first;

interface Near {
  item: LaidOutClip;
  active: boolean;
}

/** One thing to draw this frame. Slots are reused from frame to frame. */
interface Layer {
  item: LaidOutClip;
  readonly pose: ClipPose;
  readonly mix: TransitionMix;
  kind: "text" | "offline" | "picture";
  words: string;
  drawable: CanvasImageSource | null;
  /** The original's size, which Scale is relative to, and the drawable's own pixels. */
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  blend: GlobalCompositeOperation;
}

const NO_TRANSITIONS: ReadonlyMap<string, ClipTransitions> = new Map();
const NOTHING_MISSING: ReadonlyArray<string> = [];

const releaseMedia = (element: HTMLMediaElement) => {
  element.pause();
  element.removeAttribute("src");
  element.load();
};

/**
 * Plays a timeline onto one canvas. Each video clip near the playhead gets a pooled decoder
 * (a detached video element on a proxy); every animation frame draws the active clips bottom to
 * top with their Motion and Opacity. Paused, reverse and fast speeds seek; normal speeds play the
 * decoders and correct drift. Nothing runs while paused and settled.
 */
export class PreviewEngine {
  private scene: PreviewScene | null = null;
  private context: CanvasRenderingContext2D | null;
  private frameNumber = 0;
  private speed = 0;
  /**
   * Where the playhead is at each moment of the current play. Sound is scheduled against it
   * ahead of time and the picture reads it every frame, both on the audio device's clock, so
   * neither chases the other. Null while paused.
   */
  private transport: Transport | null = null;
  /** The transport a change of speed replaced, followed until the new one's sound begins. */
  private outgoing: Transport | null = null;
  private clockEpoch = 0;
  private readonly sound: AudioEngine;
  private meter: ((left: number, right: number) => void) | null = null;
  private readonly levels = new Float32Array(2);
  /** The meter is drawn until this page time after sound stops, so it falls back to rest. */
  private meterUntil = 0;
  private readonly statusListeners = new Set<() => void>();
  private loopRange: { readonly start: number; readonly end: number } | null = null;
  /** Forward playback stops here (play around, play to out), then clears. */
  private stopAt: number | null = null;
  private handle = 0;
  private needsDraw = true;
  /** When the picture started waiting on a layer, or null when nothing is waiting. */
  private holdingSince: number | null = null;
  private readonly videos = new Map<string, VideoSlot>();
  private readonly images = new Map<string, StillImage>();
  /** Derived from the layout once per scene, so no frame works them out again. */
  private videoTracks: ReadonlyArray<LaidOutTrack> = [];
  private audioTracks: ReadonlyArray<LaidOutTrack> = [];
  private plannedFor: TimelineLayout | null = null;
  private transitions = NO_TRANSITIONS;
  private notDrawnBy: ReadonlyMap<string, ReadonlyArray<string>> = new Map();
  /** Reused every frame: the clips near the playhead and the layers to draw. */
  private readonly nearVideo: Array<Near> = [];
  private nearVideoCount = 0;
  private readonly layers: Array<Layer> = [];
  private readonly textLayouts = new WeakMap<object, TextLayout | null>();
  /** Bumped when a font finishes loading, so text measured with its fallback is measured again. */
  private fontEpoch = 0;
  private notDrawnShown = "";
  private readonly onFontsLoaded = () => {
    this.fontEpoch += 1;
    this.drawn = "";
    this.invalidate();
  };
  /** Proxied clips decode through WebCodecs: null while their proxy loads. */
  private readonly decoders = new Map<string, ClipDecoder | null>();
  private readonly stopObserving: () => void;
  /** What the canvas last drew; an identical frame is not drawn again. */
  private drawn = "";
  // A hidden page gets no animation frames, so nothing would stop audio at its cut or loop.
  private readonly pauseWhenHidden = () => {
    if (document.hidden && this.speed !== 0) this.setSpeed(0);
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly listener: {
      /** `now` is the animation frame's timestamp, for throttling what the UI re-renders. */
      readonly onTime: (frame: number, now: number) => void;
      readonly onSpeed: (speed: number) => void;
      /**
       * What is at the playhead that the preview does not draw, in the user's words. Called
       * only when the list changes.
       */
      readonly onNotDrawn?: (missing: ReadonlyArray<string>) => void;
    },
  ) {
    this.context = canvas.getContext("2d");
    this.stopObserving = observeResize(canvas, () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      // Sizing a canvas clears it.
      this.drawn = "";
      this.invalidate();
    });
    document.addEventListener("visibilitychange", this.pauseWhenHidden);
    document.fonts.addEventListener("loadingdone", this.onFontsLoaded);
    this.sound = new AudioEngine({
      onChange: () => {
        if (this.speed !== 0) this.invalidate();
        else if (this.scene !== null) this.sound.prime(this.frameNumber);
      },
      onStatus: () => {
        for (const listener of this.statusListeners) listener();
      },
    });
  }

  setScene(scene: PreviewScene) {
    this.scene = scene;
    if (this.plannedFor !== scene.layout) {
      this.plannedFor = scene.layout;
      // Layout lists video top-down; draw from the bottom track up.
      this.videoTracks = scene.layout.tracks.filter((t) => t.kind === "Video").toReversed();
      this.audioTracks = scene.layout.tracks.filter((t) => t.kind === "Audio");
      this.transitions = planTransitions(scene.layout);
      const missing = new Map<string, ReadonlyArray<string>>();
      for (const track of this.videoTracks) {
        for (const item of track.clips) {
          const list = clipNotDrawn(item);
          if (list.length > 0) missing.set(item.key, list);
        }
      }
      this.notDrawnBy = missing;
      this.drawn = "";
      this.sound.setScene(scene.layout, this.transitions, this.audioUrl);
      // Playing, the sound already scheduled belongs to the old timeline.
      if (this.speed !== 0) this.startTransport(performance.now(), true);
      else this.sound.prime(this.frameNumber);
    } else {
      this.sound.setUrls(this.audioUrl);
    }
    // Fetch proxies in the background, nearest the playhead first, so a jump anywhere decodes
    // without waiting on the drive.
    if (webCodecsAvailable()) {
      const distance = new Map<string, number>();
      for (const track of scene.layout.tracks) {
        if (track.kind !== "Video") continue;
        for (const item of track.clips) {
          const source = this.source(scene, item);
          if (source?.videoProxy !== true || !source.video) continue;
          const away = Math.abs(item.startFrame - this.frameNumber);
          if (away < (distance.get(source.video) ?? Infinity)) distance.set(source.video, away);
        }
      }
      prefetchProxies([...distance].toSorted((a, b) => a[1] - b[1]).map(([url]) => url));
    }
    this.invalidate();
  }

  setLoop(range: { readonly start: number; readonly end: number } | null) {
    this.loopRange = range;
    if (this.speed !== 0) this.startTransport(performance.now(), true);
  }

  get playing() {
    return this.speed !== 0;
  }

  get currentFrame() {
    return this.frameNumber;
  }

  seek(frame: number) {
    const from = this.frameNumber;
    this.frameNumber = this.clamp(frame);
    const now = performance.now();
    if (this.speed !== 0) {
      this.startTransport(now, false);
    } else {
      // A step or a drag is a gesture, which is when a browser lets sound start.
      if (navigator.userActivation?.isActive === true) this.sound.unlock();
      if (this.frameNumber !== from) {
        this.sound.scrub(this.frameNumber, this.frameNumber - from);
        this.meterUntil = now + METER_REST_MS;
      }
      this.sound.prime(this.frameNumber);
    }
    this.listener.onTime(this.frameNumber, now);
    this.invalidate();
  }

  /** Signed speed: 1 is normal play, negative is reverse, 0 pauses. `stopAt` ends forward play. */
  setSpeed(speed: number, options?: { readonly stopAt?: number }) {
    const now = performance.now();
    const was = this.speed;
    this.stopAt = speed > 0 ? (options?.stopAt ?? null) : null;
    this.speed = speed;
    if (speed === 0) {
      if (was !== 0) this.haltTransport(now);
    } else {
      this.sound.unlock();
      // From rest, play starts where the playhead stands; a change of speed carries on.
      this.startTransport(now, was !== 0);
    }
    this.listener.onSpeed(speed);
    this.invalidate();
  }

  private readonly audioUrl = (target: string): string | null => {
    const source = target === "" ? undefined : this.scene?.sources.get(target);
    return source?.audioProxy === true ? source.audio : null;
  };

  /**
   * Starts a transport at the current speed and hands it to the sound. `continuing` joins it
   * to the one playing, at the moment its sound can start, so a change of speed, loop or
   * timeline carries on from where the old sound leaves off.
   */
  private startTransport(now: number, continuing: boolean) {
    const scene = this.scene;
    if (scene === null || this.speed === 0) return;
    // Reading the clock first settles which clock it is, before anything is timed on it.
    const heard = this.sound.clock(now);
    const t0 = this.sound.startTime(now);
    const previous = continuing && this.clockEpoch === this.sound.epoch ? this.transport : null;
    this.clockEpoch = this.sound.epoch;
    this.outgoing = previous !== null && heard < t0 ? previous : null;
    this.transport = new Transport({
      t0,
      frame: previous === null ? this.frameNumber : previous.frameAt(t0),
      speed: this.speed,
      rate: scene.layout.rate,
      duration: scene.layout.durationFrames,
      loop: this.loopRange,
      stopAt: this.stopAt,
    });
    if (previous === null) this.frameNumber = this.transport.startFrame;
    this.sound.play(this.transport);
  }

  /** Ends the transport where the playhead is heard to be, and silences the sound. */
  private haltTransport(now: number) {
    this.advance(now);
    this.transport = null;
    this.outgoing = null;
    this.stopAt = null;
    this.sound.stop();
    this.sound.prime(this.frameNumber);
    this.meterUntil = now + METER_REST_MS;
  }

  /** Moves the playhead to where the transport is at page time `now`; true once it has ended. */
  private advance(now: number): boolean {
    let t = this.sound.clock(now);
    if (this.sound.epoch !== this.clockEpoch) {
      // The clock changed hands (sound started, stopped or was blocked): carry on from here.
      if (this.speed === 0) return true;
      this.startTransport(now, false);
      t = this.sound.clock(now);
    }
    const transport = this.transport;
    if (transport === null) return true;
    if (this.outgoing !== null && t >= transport.t0) this.outgoing = null;
    const following = this.outgoing ?? transport;
    let frame = following.frameAt(t);
    // The audio clock is re-measured as it runs; a correction never steps the picture back.
    const back = (this.frameNumber - frame) * Math.sign(following.fps);
    if (back > 0 && back < Math.abs(following.fps) * CLOCK_SLACK_SECONDS) frame = this.frameNumber;
    const ended = this.outgoing === null && t >= transport.endsAt;
    this.frameNumber = ended ? transport.finalFrame : frame;
    return ended;
  }

  /** Scrub audio: a moment of sound at each step or drag of the paused playhead. */
  setScrubAudio(enabled: boolean) {
    this.sound.scrubEnabled = enabled;
  }

  /** Lets sound start. Call from a click or a key press, which is when browsers allow it. */
  unlockAudio() {
    this.sound.unlock();
    if (this.speed !== 0) this.invalidate();
  }

  get audioStatus(): AudioStatus {
    return this.sound.currentStatus;
  }

  readonly subscribeAudioStatus = (listener: () => void) => {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  };

  /** Draws the output level, called with each channel's peak on frames where sound may play. */
  setMeter(draw: ((left: number, right: number) => void) | null) {
    this.meter = draw;
  }

  /** For measurement: the audio context and the node everything is heard through. */
  audioProbe() {
    return this.sound.probe();
  }

  /** Full screen keeps the frame's aspect; the picture letterboxes inside the screen. */
  requestFullscreen() {
    void this.canvas.requestFullscreen().catch(() => undefined);
  }

  destroy() {
    cancelAnimationFrame(this.handle);
    this.stopObserving();
    document.removeEventListener("visibilitychange", this.pauseWhenHidden);
    document.fonts.removeEventListener("loadingdone", this.onFontsLoaded);
    for (const slot of this.videos.values()) releaseMedia(slot.element);
    this.videos.clear();
    for (const still of this.images.values()) still.bitmap?.close();
    for (const decoder of this.decoders.values()) decoder?.close();
    this.decoders.clear();
    this.images.clear();
    this.sound.destroy();
    this.statusListeners.clear();
    this.meter = null;
  }

  private clamp(frame: number) {
    return Math.min(Math.max(0, frame), this.scene?.layout.durationFrames ?? 0);
  }

  private invalidate() {
    this.needsDraw = true;
    if (this.handle === 0) this.handle = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number) => {
    this.handle = 0;
    const scene = this.scene;
    if (scene === null) return;
    if (this.speed !== 0) {
      if (this.advance(now)) {
        // Playback reached its end, or the place it was asked to stop.
        this.speed = 0;
        this.haltTransport(now);
        this.listener.onSpeed(0);
      } else {
        this.sound.pump();
      }
      this.listener.onTime(this.frameNumber, now);
    }
    const metering = this.meter !== null && (this.speed !== 0 || now < this.meterUntil);
    if (metering && this.meter !== null) {
      this.sound.readLevels(this.levels);
      this.meter(this.levels[0]!, this.levels[1]!);
    }
    const settled = this.sync(scene);
    if (this.needsDraw || this.speed !== 0) {
      // Paused or seeking, hold the previous picture briefly for every layer's frame, so a scrub
      // doesn't flash; playing, never hold, since one slow clip would freeze the whole picture.
      if (settled || (this.speed > 0 && this.speed <= 4)) {
        this.draw(scene);
        this.needsDraw = false;
        this.holdingSince = null;
      } else {
        this.holdingSince ??= now;
        if (now - this.holdingSince >= MAX_HOLD_MS) {
          this.draw(scene);
          this.holdingSince = now;
        }
      }
    }
    if (this.speed !== 0 || this.needsDraw || metering) {
      this.handle = requestAnimationFrame(this.tick);
    }
  };

  /**
   * Fills `near` with the clips around the playhead, bottom track first, and returns how many.
   * A clip is active across its transitions too: from where it starts to come in to where it
   * has gone out.
   */
  private clipsNear(scene: PreviewScene, tracks: ReadonlyArray<LaidOutTrack>, near: Array<Near>) {
    const warm = WARM_SECONDS * scene.layout.rate;
    const frame = this.frameNumber;
    let count = 0;
    for (const track of tracks) {
      for (const item of track.clips) {
        if (item.clip.enabled === false) continue;
        const transitions = this.transitions.get(item.key);
        const from = windowStart(item, transitions);
        const to = windowEnd(item, transitions);
        if (to <= frame - warm || from > frame + warm) continue;
        let slot = near[count];
        if (slot === undefined) {
          slot = { item, active: false };
          near.push(slot);
        }
        slot.item = item;
        slot.active = from <= frame && frame < to;
        count += 1;
      }
    }
    return count;
  }

  private source(scene: PreviewScene, item: LaidOutClip) {
    const target = item.clip.media_references.DEFAULT_MEDIA.target_url;
    return target === "" ? undefined : scene.sources.get(target);
  }

  /** Points every decoder at its time; true once all active video layers can draw. */
  private sync(scene: PreviewScene): boolean {
    const rate = scene.layout.rate;
    const nativePlayback = this.speed > 0 && this.speed <= 4;
    let settled = true;

    this.nearVideoCount = this.clipsNear(scene, this.videoTracks, this.nearVideo);
    const liveVideos = new Set<string>();
    for (let index = 0; index < this.nearVideoCount; index++) {
      const { item, active } = this.nearVideo[index]!;
      const transitions = this.transitions.get(item.key);
      const from = windowStart(item, transitions);
      const to = windowEnd(item, transitions);
      // A clip's own speed rides on the transport's; reversed and very fast clips seek instead.
      const scalar = timeScalarOf(item.clip);
      const mediaSpeed = this.speed * scalar;
      const native = nativePlayback && scalar > 0 && mediaSpeed <= 4;
      const source = clipSourceAt(item, rate, Math.max(this.frameNumber, from));
      const still = this.source(scene, item)?.still;
      if (still) this.image(still);
      const url = this.source(scene, item)?.video;
      if (!url) continue;
      liveVideos.add(item.key);
      if (this.source(scene, item)?.videoProxy === true && webCodecsAvailable()) {
        // The clip's proxy finished building while its original was playing.
        const original = this.videos.get(item.key);
        if (original !== undefined) {
          releaseMedia(original.element);
          this.videos.delete(item.key);
        }
        if (!this.syncDecoder(item, url, active, native, source, mediaSpeed, to)) settled = false;
        continue;
      }
      let slot = this.videos.get(item.key);
      if (slot !== undefined && slot.url !== url) {
        releaseMedia(slot.element);
        slot = undefined;
      }
      if (slot === undefined) {
        const element = document.createElement("video");
        element.muted = true;
        element.playsInline = true;
        element.preload = "auto";
        element.src = url;
        element.addEventListener("seeked", () => this.invalidate());
        element.addEventListener("loadeddata", () => this.invalidate());
        const created: VideoSlot = { element, url, wanted: Number.NaN, failed: false };
        element.addEventListener("error", () => {
          created.failed = true;
          this.invalidate();
        });
        slot = created;
        this.videos.set(item.key, slot);
      }
      const element = slot.element;
      const preroll =
        native && from > this.frameNumber
          ? prerollTarget(source, from - this.frameNumber, rate, this.speed, mediaSpeed)
          : null;
      if (active && native) {
        follow(element, source, mediaSpeed);
        if (element.paused) void element.play().catch(() => undefined);
        slot.wanted = Number.NaN;
      } else if (preroll !== null) {
        const target = preroll;
        if (element.paused) {
          // Parked at its pre-roll point already, so starting needs no seek (and no stall).
          if (Math.abs(element.currentTime - target) > 0.05) element.currentTime = target;
          void element.play().catch(() => undefined);
        } else {
          follow(element, target, mediaSpeed);
        }
        slot.wanted = Number.NaN;
      } else {
        if (!element.paused) element.pause();
        // Finished clips just wait to be released; upcoming ones park where they'll start.
        const target =
          to <= this.frameNumber
            ? null
            : native && from > this.frameNumber
              ? parkTarget(source, mediaSpeed)
              : // A little past the frame's start so the decoder doesn't land on the previous one.
                source + 0.001;
        if (target !== null && Math.abs(slot.wanted - target) > 1 / 240) {
          slot.wanted = target;
          element.currentTime = target;
        }
      }
      if (active && !slot.failed && (element.readyState < 2 || (element.seeking && !native))) {
        settled = false;
      }
    }
    for (const [key, slot] of this.videos) {
      if (liveVideos.has(key)) continue;
      releaseMedia(slot.element);
      this.videos.delete(key);
    }
    for (const [key, decoder] of this.decoders) {
      if (liveVideos.has(key)) continue;
      decoder?.close();
      this.decoders.delete(key);
    }

    return settled;
  }

  /**
   * Points a clip's WebCodecs decoder at its time. Playing, active and upcoming clips keep frames
   * decoded ahead (upcoming from their first frame, so a cut needs no restart); otherwise the
   * exact frame decodes. Returns false while an active clip's frame isn't ready yet.
   */
  private syncDecoder(
    item: LaidOutClip,
    url: string,
    active: boolean,
    playing: boolean,
    source: number,
    mediaSpeed: number,
    to: number,
  ): boolean {
    if (!this.decoders.has(item.key)) {
      this.decoders.set(item.key, null);
      void loadProxy(url).then((proxy) => {
        if (proxy === null || !this.decoders.has(item.key)) return;
        this.decoders.set(item.key, new ClipDecoder(proxy, () => this.invalidate()));
        this.invalidate();
      });
    }
    const decoder = this.decoders.get(item.key) ?? null;
    if (decoder === null) return !active;
    if (playing && to > this.frameNumber) decoder.playing(source, mediaSpeed);
    else if (to > this.frameNumber) decoder.exact(source);
    return !active || decoder.broken || decoder.frameAt(source, !playing) !== null;
  }

  /** Starts decoding a still off the main thread; returns it once ready to draw. */
  private image(url: string): StillImage | null {
    let still = this.images.get(url);
    if (still === undefined) {
      const entry: StillImage = { bitmap: null, width: 0, height: 0 };
      still = entry;
      this.images.set(url, entry);
      void fetch(url)
        .then((response) => response.blob())
        .then(async (blob) => {
          const full = await createImageBitmap(blob);
          entry.width = full.width;
          entry.height = full.height;
          const scale = Math.min(1, STILL_MAX_EDGE / Math.max(full.width, full.height));
          if (scale < 1) {
            full.close();
            entry.bitmap = await createImageBitmap(blob, {
              resizeWidth: Math.round(entry.width * scale),
              resizeHeight: Math.round(entry.height * scale),
              resizeQuality: "medium",
            });
          } else {
            entry.bitmap = full;
          }
          this.invalidate();
        })
        .catch(() => undefined);
    }
    return still.bitmap === null ? null : still;
  }

  /** The next layer slot for this frame, with its pose and transition mix ready to fill in. */
  private layer(index: number, item: LaidOutClip): Layer {
    let slot = this.layers[index];
    if (slot === undefined) {
      slot = {
        item,
        pose: emptyPose(),
        mix: emptyMix(),
        kind: "offline",
        words: "",
        drawable: null,
        width: 0,
        height: 0,
        pixelWidth: 0,
        pixelHeight: 0,
        blend: "source-over",
      };
      this.layers.push(slot);
    }
    slot.item = item;
    slot.drawable = null;
    return slot;
  }

  /** Tells the Monitor what at the playhead is left out, when that changes. */
  private reportNotDrawn(scene: PreviewScene) {
    if (this.listener.onNotDrawn === undefined) return;
    const frame = this.frameNumber;
    let signature = "";
    for (let index = 0; index < this.nearVideoCount; index++) {
      const { item, active } = this.nearVideo[index]!;
      if (!active) continue;
      if (this.notDrawnBy.has(item.key)) signature += `${item.key}|`;
    }
    // A transition with no drawing plays as a cut; say so while the playhead is inside it.
    for (const tracks of [this.videoTracks, this.audioTracks]) {
      for (const track of tracks) {
        for (const item of track.clips) {
          if (item.startFrame > frame + scene.layout.rate * WARM_SECONDS) break;
          const span = this.transitions.get(item.key)?.in ?? this.transitions.get(item.key)?.out;
          if (span === undefined || span === null || span.kind !== null) continue;
          if (frame >= span.start && frame < span.end) signature += `t:${span.name}|`;
        }
      }
    }
    if (signature === this.notDrawnShown) return;
    this.notDrawnShown = signature;
    if (signature === "") {
      this.listener.onNotDrawn(NOTHING_MISSING);
      return;
    }
    const missing = new Set<string>();
    for (const part of signature.split("|")) {
      if (part.startsWith("t:")) missing.add(`${part.slice(2)} transition`);
      else for (const name of this.notDrawnBy.get(part) ?? []) missing.add(name);
    }
    this.listener.onNotDrawn([...missing]);
  }

  private draw(scene: PreviewScene) {
    const context = this.context;
    if (context === null) return;
    this.reportNotDrawn(scene);
    const pixels = Math.min(
      this.canvas.width / scene.frame.width,
      this.canvas.height / scene.frame.height,
    );
    const width = scene.frame.width * pixels;
    const height = scene.frame.height * pixels;
    const left = (this.canvas.width - width) / 2;
    const top = (this.canvas.height - height) / 2;

    // Work out every layer first. On a display faster than the footage (120 Hz showing 60 fps)
    // most animation frames have nothing new, and those skip the canvas entirely.
    let count = 0;
    let signature = `${this.canvas.width}x${this.canvas.height}/${scene.frame.width}x${scene.frame.height}/${this.fontEpoch}`;
    for (let index = 0; index < this.nearVideoCount; index++) {
      const { item, active } = this.nearVideo[index]!;
      if (!active) continue;
      const layer = this.layer(count, item);
      const { pose, mix } = layer;
      mixAt(this.transitions.get(item.key), this.frameNumber, mix);
      if (!mix.visible) continue;
      poseAt(transformOf(item), clipOffset(item, scene.layout.rate, this.frameNumber), pose);
      const sourceTime = clipSourceAt(item, scene.layout.rate, this.frameNumber);
      const source = this.source(scene, item);
      const mode = graphicOf(item).blendMode;
      layer.blend = (mode === undefined ? undefined : CANVAS_BLEND[mode]) ?? "source-over";
      const posed = `|${item.key}@${pose.x},${pose.y},${pose.scale},${pose.rotation},${pose.opacity * mix.opacity},${mix.dip},${pose.cropLeft},${pose.cropTop},${pose.cropRight},${pose.cropBottom}`;
      if (source === undefined) {
        const words = graphicText(item);
        if (words === "") continue;
        layer.kind = "text";
        layer.words = words;
        count += 1;
        signature += `${posed}t${words}`;
        continue;
      }
      let drawable: CanvasImageSource | null = null;
      let naturalWidth = source.width ?? 0;
      let naturalHeight = source.height ?? 0;
      let pixelWidth = 0;
      let pixelHeight = 0;
      let stamp = "";
      if (source.still) {
        const still = this.image(source.still);
        drawable = still?.bitmap ?? null;
        naturalWidth ||= still?.width ?? 0;
        naturalHeight ||= still?.height ?? 0;
        pixelWidth = still?.bitmap?.width ?? 0;
        pixelHeight = still?.bitmap?.height ?? 0;
        stamp = "s";
      } else {
        const decoder = this.decoders.get(item.key);
        const slot = this.videos.get(item.key);
        const frame = decoder?.frameAt(sourceTime) ?? null;
        if (frame !== null) {
          drawable = frame;
          pixelWidth = frame.displayWidth;
          pixelHeight = frame.displayHeight;
          stamp = `f${frame.timestamp}`;
        } else if (slot && slot.element.readyState >= 2) {
          drawable = slot.element;
          pixelWidth = slot.element.videoWidth;
          pixelHeight = slot.element.videoHeight;
          stamp = `e${slot.element.currentTime}`;
        }
        naturalWidth ||= pixelWidth;
        naturalHeight ||= pixelHeight;
      }
      if (drawable === null || naturalWidth === 0) {
        const failed =
          this.videos.get(item.key)?.failed === true ||
          this.decoders.get(item.key)?.broken === true;
        if (failed || (!source.video && !source.still)) {
          layer.kind = "offline";
          count += 1;
          signature += `${posed}o`;
        }
        continue;
      }
      layer.kind = "picture";
      layer.drawable = drawable;
      layer.width = naturalWidth;
      layer.height = naturalHeight;
      layer.pixelWidth = pixelWidth;
      layer.pixelHeight = pixelHeight;
      count += 1;
      signature += `${posed}${stamp}`;
    }
    if (signature === this.drawn) return;
    this.drawn = signature;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "#000";
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.save();
    context.beginPath();
    context.rect(left, top, width, height);
    context.clip();
    for (let index = 0; index < count; index++) {
      const layer = this.layers[index]!;
      const { pose, mix } = layer;
      const alpha = Math.min(1, Math.max(0, pose.opacity * mix.opacity));
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = alpha;
      context.globalCompositeOperation = layer.blend;
      context.translate(left + pose.x * width, top + pose.y * height);
      context.rotate((pose.rotation * Math.PI) / 180);
      if (layer.kind === "text") {
        const layout = this.textLayout(layer.item, layer.words, scene.frame.height);
        // A dip takes text to the colour by fading it, which over black or white reads the same.
        context.globalAlpha = alpha * (1 - mix.dip);
        if (layout !== null) {
          paintText(context, layout, {
            scale: pose.scale * pixels,
            width: width * pose.scale,
            height: height * pose.scale,
            anchor: graphicTextPosition(layer.item),
            fontEpoch: this.fontEpoch,
          });
        } else {
          this.drawText(context, layer.words, {
            scale: pose.scale,
            width,
            height,
            anchor: graphicTextPosition(layer.item),
          });
        }
      } else if (layer.kind === "offline") {
        this.drawOffline(context, layer.item.clip.name, height);
      } else if (layer.drawable !== null) {
        const w = layer.width * pose.scale * pixels;
        const h = layer.height * pose.scale * pixels;
        const keepX = 1 - pose.cropLeft - pose.cropRight;
        const keepY = 1 - pose.cropTop - pose.cropBottom;
        if (keepX <= 0 || keepY <= 0) continue;
        const x = -w / 2 + w * pose.cropLeft;
        const y = -h / 2 + h * pose.cropTop;
        if (keepX === 1 && keepY === 1) {
          context.drawImage(layer.drawable, x, y, w, h);
        } else {
          context.drawImage(
            layer.drawable,
            layer.pixelWidth * pose.cropLeft,
            layer.pixelHeight * pose.cropTop,
            layer.pixelWidth * keepX,
            layer.pixelHeight * keepY,
            x,
            y,
            w * keepX,
            h * keepY,
          );
        }
        if (mix.dip > 0) {
          context.globalCompositeOperation = "source-over";
          context.globalAlpha = alpha * mix.dip;
          context.fillStyle = mix.dipWhite ? "#fff" : "#000";
          context.fillRect(x, y, w * keepX, h * keepY);
        }
      }
      // Frames are only borrowed from their decoder for this draw.
      layer.drawable = null;
    }
    context.restore();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
  }

  /** The styled layout of a clip's text, or null when the pull gave it no style to follow. */
  private textLayout(item: LaidOutClip, words: string, frameHeight: number): TextLayout | null {
    const cached = this.textLayouts.get(item.clip);
    if (cached !== undefined) return cached;
    const style = graphicOf(item).textStyle;
    // Unsized runs get the size captions and titles usually have on the frame.
    const layout = style === undefined ? null : layoutText(style, words, frameHeight * 0.04);
    this.textLayouts.set(item.clip, layout);
    return layout;
  }

  /**
   * Draws text whose style was not read (a timeline pulled before styles were) around its text
   * layer's anchor, in a bold sans at caption size. An anchor near the left edge is a paragraph
   * box spanning the frame symmetrically, so its text centres.
   */
  private drawText(
    context: CanvasRenderingContext2D,
    words: string,
    input: {
      readonly scale: number;
      readonly width: number;
      readonly height: number;
      readonly anchor: readonly [number, number] | null;
    },
  ) {
    const { width, height, anchor } = input;
    const size = Math.max(10, height * 0.04 * input.scale);
    const [ax, ay] = anchor ?? [0.5, 0.5];
    const boxed = anchor !== null && ax < 0.4;
    // The context is already at the Motion position (the frame centre by default).
    const x = boxed ? 0 : (ax - 0.5) * width;
    const y = (ay - 0.5) * height;
    context.font = `700 ${size}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = boxed ? "top" : "middle";
    context.fillStyle = "#fff";
    context.shadowColor = "rgba(0,0,0,0.85)";
    context.shadowBlur = size / 3;
    const lines = words.split(/\s*[\r\n]+\s*/);
    lines.forEach((line, index) => {
      const offset = boxed ? index : index - (lines.length - 1) / 2;
      const top = y + offset * size * 1.2;
      if (boxed) context.fillText(line, x, top, width * (1 - 2 * ax));
      else context.fillText(line, x, top);
    });
    context.shadowBlur = 0;
  }

  private drawOffline(context: CanvasRenderingContext2D, name: string, height: number) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.font = `500 ${Math.max(10, height * 0.025)}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.fillStyle = "rgba(255,255,255,0.6)";
    context.fillText(`${name} is offline`, this.canvas.width / 2, this.canvas.height / 2);
  }
}
