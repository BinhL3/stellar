import type { LaidOutClip, TimelineLayout } from "@t3tools/timeline/layout";

import { observeResize } from "~/lib/observeResize";

import { ClipDecoder, loadProxy, prefetchProxies, webCodecsAvailable } from "./clipDecoder";

import {
  type ClipPose,
  clipTimes,
  graphicText,
  graphicTextPosition,
  poseAt,
  transformOf,
} from "./clipTransform";

/** What the engine plays for one media file; URLs are null when unavailable. */
export interface PreviewSource {
  readonly video: string | null;
  readonly audio: string | null;
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
// Audio above this speed is noise, so it mutes, as editors do when shuttling fast.
const MAX_AUDIO_SPEED = 2;

interface AudioSlot {
  readonly element: HTMLAudioElement;
  readonly url: string;
  /** The clip's gain stage in the mix; null until the first play creates the audio graph. */
  gain: GainNode | null;
}

interface VideoSlot {
  readonly element: HTMLVideoElement;
  readonly url: string;
  /** Source seconds the slot last seeked to while paused, so it doesn't re-seek each tick. */
  wanted: number;
  /** The file failed to load; it draws as offline instead of holding the picture forever. */
  failed: boolean;
}

// Changing an element's rate resets its audio resampler (a click), so rates move in steps.
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
 * Where an upcoming clip's media should be now so it reaches its first frame exactly at its cut,
 * or null when the cut is too far off or the clip starts at its media's very beginning.
 */
const prerollTarget = (item: LaidOutClip, rate: number, frame: number, speed: number) => {
  const until = (item.startFrame - frame) / rate / speed;
  if (until > PREROLL_SECONDS || until <= 0) return null;
  const { start_time } = item.clip.source_range;
  const target = start_time.value / start_time.rate - until * speed;
  return target < 0 ? null : target;
};

/** Where an upcoming clip waits while playing: its pre-roll start, so starting it needs no seek. */
const parkTarget = (item: LaidOutClip, speed: number) => {
  const start = item.clip.source_range.start_time;
  const first = start.value / start.rate;
  return first - PREROLL_SECONDS * speed >= 0 ? first - PREROLL_SECONDS * speed : first;
};

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
  private anchor = { wall: 0, frame: 0 };
  /**
   * The playing clip that keeps time, preferably audio: the playhead follows its media clock and
   * every other clip follows the playhead, so nothing fights the element people are listening to.
   */
  private lead: { readonly element: HTMLMediaElement; readonly item: LaidOutClip } | null = null;
  private loopRange: { readonly start: number; readonly end: number } | null = null;
  /** Forward playback stops here (play around, play to out), then clears. */
  private stopAt: number | null = null;
  private handle = 0;
  private needsDraw = true;
  /** When the picture started waiting on a layer, or null when nothing is waiting. */
  private holdingSince: number | null = null;
  private readonly videos = new Map<string, VideoSlot>();
  private readonly audios = new Map<string, AudioSlot>();
  private mix: { readonly context: AudioContext; readonly bus: GainNode } | null = null;
  private readonly images = new Map<string, StillImage>();
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
  }

  setScene(scene: PreviewScene) {
    this.scene = scene;
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
  }

  get playing() {
    return this.speed !== 0;
  }

  get currentFrame() {
    return this.frameNumber;
  }

  seek(frame: number) {
    this.frameNumber = this.clamp(frame);
    this.anchor = { wall: performance.now(), frame: this.frameNumber };
    this.listener.onTime(this.frameNumber, performance.now());
    this.invalidate();
  }

  /** Signed speed: 1 is normal play, negative is reverse, 0 pauses. `stopAt` ends forward play. */
  setSpeed(speed: number, options?: { readonly stopAt?: number }) {
    this.stopAt = speed > 0 ? (options?.stopAt ?? null) : null;
    const end = this.scene?.layout.durationFrames ?? 0;
    if (speed > 0 && this.frameNumber >= end) this.frameNumber = this.loopRange?.start ?? 0;
    if (speed < 0 && this.frameNumber <= 0) this.frameNumber = end;
    this.anchor = { wall: performance.now(), frame: this.frameNumber };
    this.speed = speed;
    if (speed !== 0) this.ensureMix();
    this.listener.onSpeed(speed);
    this.invalidate();
  }

  /**
   * The mix: each audio clip has a gain stage (so Premiere's boosts above 0 dB play as boosts)
   * into a bus with a brick-wall limiter, so stacked dialogue, music and effects can't clip.
   * Created on the first play, which is a user gesture, as browsers require.
   */
  private ensureMix() {
    if (this.mix === null) {
      const context = new AudioContext({ latencyHint: "playback" });
      const limiter = new DynamicsCompressorNode(context, {
        threshold: -1,
        knee: 0,
        ratio: 20,
        attack: 0.002,
        release: 0.12,
      });
      const bus = new GainNode(context);
      bus.connect(limiter).connect(context.destination);
      this.mix = { context, bus };
    }
    if (this.mix.context.state === "suspended") void this.mix.context.resume();
  }

  /** Full screen keeps the frame's aspect; the picture letterboxes inside the screen. */
  requestFullscreen() {
    void this.canvas.requestFullscreen().catch(() => undefined);
  }

  destroy() {
    cancelAnimationFrame(this.handle);
    this.stopObserving();
    document.removeEventListener("visibilitychange", this.pauseWhenHidden);
    for (const slot of this.videos.values()) releaseMedia(slot.element);
    for (const slot of this.audios.values()) {
      slot.gain?.disconnect();
      releaseMedia(slot.element);
    }
    this.videos.clear();
    this.audios.clear();
    for (const still of this.images.values()) still.bitmap?.close();
    for (const decoder of this.decoders.values()) decoder?.close();
    this.decoders.clear();
    this.images.clear();
    void this.mix?.context.close();
    this.mix = null;
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
    const rate = scene.layout.rate;
    if (this.speed !== 0) {
      let frame = this.anchor.frame + ((now - this.anchor.wall) / 1000) * this.speed * rate;
      const lead = this.lead;
      if (
        lead !== null &&
        this.speed > 0 &&
        !lead.element.paused &&
        !lead.element.seeking &&
        lead.element.readyState >= 3
      ) {
        const { start_time } = lead.item.clip.source_range;
        const leadFrame =
          lead.item.startFrame +
          (lead.element.currentTime - start_time.value / start_time.rate) * rate;
        if (Math.abs(leadFrame - frame) < rate * RESYNC_SECONDS) {
          // Never step back: media clocks jitter and round (0.833333 s against 25/30), and a
          // playhead a hair before 0 would read as running off the timeline's start.
          frame = Math.max(this.frameNumber, leadFrame);
          this.anchor = { wall: now, frame };
        }
      }
      const loop = this.loopRange;
      const start = loop?.start ?? 0;
      const end = loop?.end ?? scene.layout.durationFrames;
      if (this.stopAt !== null && frame >= this.stopAt) {
        frame = this.stopAt;
        this.stopAt = null;
        this.speed = 0;
        this.listener.onSpeed(0);
      } else if (frame >= end || frame < start) {
        if (loop !== null && this.speed > 0) {
          frame = start;
          this.anchor = { wall: now, frame };
        } else {
          frame = Math.min(Math.max(frame, start), end);
          this.speed = 0;
          this.listener.onSpeed(0);
        }
      }
      this.frameNumber = frame;
      this.listener.onTime(frame, now);
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
    if (this.speed !== 0 || this.needsDraw) this.handle = requestAnimationFrame(this.tick);
  };

  private clipsNear(scene: PreviewScene, kind: "Video" | "Audio") {
    const warm = WARM_SECONDS * scene.layout.rate;
    const frame = this.frameNumber;
    const near: Array<{ item: LaidOutClip; layer: number; active: boolean }> = [];
    const tracks = scene.layout.tracks.filter((t) => t.kind === kind);
    // Layout lists video top-down; draw from the bottom track up.
    const ordered = kind === "Video" ? tracks.toReversed() : tracks;
    ordered.forEach((track, layer) => {
      for (const item of track.clips) {
        if (item.clip.enabled === false) continue;
        if (item.endFrame <= frame - warm || item.startFrame > frame + warm) continue;
        near.push({
          item,
          layer,
          active: item.startFrame <= frame && frame < item.endFrame,
        });
      }
    });
    return near;
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
    let nextLead: { element: HTMLMediaElement; item: LaidOutClip } | null = null;
    let videoLead: { element: HTMLMediaElement; item: LaidOutClip } | null = null;

    const videoClips = this.clipsNear(scene, "Video");
    const liveVideos = new Set<string>();
    for (const { item, active } of videoClips) {
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
        if (!this.syncDecoder(item, url, rate, active, nativePlayback)) settled = false;
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
      const { source } = clipTimes(item, rate, Math.max(this.frameNumber, item.startFrame));
      const element = slot.element;
      if (active && nativePlayback) {
        if (this.lead?.element === element) {
          if (Math.abs(element.currentTime - source) > RESYNC_SECONDS) element.currentTime = source;
          setRate(element, this.speed);
        } else {
          follow(element, source, this.speed);
        }
        if (element.paused) void element.play().catch(() => undefined);
        slot.wanted = Number.NaN;
        videoLead ??= { element, item };
      } else if (
        nativePlayback &&
        item.startFrame > this.frameNumber &&
        prerollTarget(item, rate, this.frameNumber, this.speed) !== null
      ) {
        const target = prerollTarget(item, rate, this.frameNumber, this.speed) ?? source;
        if (element.paused) {
          // Parked at its pre-roll point already, so starting needs no seek (and no stall).
          if (Math.abs(element.currentTime - target) > 0.05) element.currentTime = target;
          void element.play().catch(() => undefined);
        } else {
          follow(element, target, this.speed);
        }
        slot.wanted = Number.NaN;
      } else {
        if (!element.paused) element.pause();
        // Finished clips just wait to be released; upcoming ones park where they'll start.
        const target =
          item.endFrame <= this.frameNumber
            ? null
            : nativePlayback && item.startFrame > this.frameNumber
              ? parkTarget(item, this.speed)
              : // A little past the frame's start so the decoder doesn't land on the previous one.
                source + 0.001;
        if (target !== null && Math.abs(slot.wanted - target) > 1 / 240) {
          slot.wanted = target;
          element.currentTime = target;
        }
      }
      if (
        active &&
        !slot.failed &&
        (element.readyState < 2 || (element.seeking && !nativePlayback))
      ) {
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

    const audioClips = this.clipsNear(scene, "Audio");
    const liveAudio = new Set<string>();
    const audible = this.speed > 0 && this.speed <= MAX_AUDIO_SPEED;
    for (const { item, active } of audioClips) {
      const url = this.source(scene, item)?.audio;
      if (!url) continue;
      liveAudio.add(item.key);
      let slot = this.audios.get(item.key);
      if (slot !== undefined && slot.url !== url) {
        slot.gain?.disconnect();
        releaseMedia(slot.element);
        slot = undefined;
      }
      if (slot === undefined) {
        const created = new Audio();
        // Routing a cross-origin element into Web Audio needs CORS, or it plays silence.
        created.crossOrigin = "anonymous";
        created.preload = "auto";
        created.src = url;
        slot = { element: created, url, gain: null };
        this.audios.set(item.key, slot);
      }
      const element = slot.element;
      if (slot.gain === null && this.mix !== null) {
        slot.gain = new GainNode(this.mix.context);
        this.mix.context.createMediaElementSource(element).connect(slot.gain).connect(this.mix.bus);
      }
      const { source, offset } = clipTimes(item, rate, Math.max(this.frameNumber, item.startFrame));
      if (active && audible) {
        const level = 10 ** (poseAt(transformOf(item), offset).gainDb / 20);
        if (slot.gain === null) element.volume = Math.min(1, level);
        else slot.gain.gain.value = level;
        if (this.lead?.element === element) {
          if (Math.abs(element.currentTime - source) > RESYNC_SECONDS) element.currentTime = source;
          setRate(element, this.speed);
        } else {
          follow(element, source, this.speed);
        }
        if (element.paused) void element.play().catch(() => undefined);
        nextLead ??= { element, item };
      } else if (
        audible &&
        slot.gain !== null &&
        item.startFrame > this.frameNumber &&
        prerollTarget(item, rate, this.frameNumber, this.speed) !== null
      ) {
        // Silent until its cut, through its own gain stage.
        slot.gain.gain.value = 0;
        const target = prerollTarget(item, rate, this.frameNumber, this.speed) ?? source;
        if (element.paused) {
          // Parked at its pre-roll point already, so starting needs no seek (and no stall).
          if (Math.abs(element.currentTime - target) > 0.05) element.currentTime = target;
          void element.play().catch(() => undefined);
        } else {
          follow(element, target, this.speed);
        }
      } else {
        if (!element.paused) element.pause();
        const target =
          item.endFrame <= this.frameNumber
            ? null
            : audible && item.startFrame > this.frameNumber
              ? parkTarget(item, this.speed)
              : source;
        if (target !== null && Math.abs(element.currentTime - target) > 0.05) {
          element.currentTime = target;
        }
      }
    }
    for (const [key, slot] of this.audios) {
      if (liveAudio.has(key)) continue;
      slot.gain?.disconnect();
      releaseMedia(slot.element);
      this.audios.delete(key);
    }
    this.lead = nativePlayback ? (nextLead ?? videoLead) : null;
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
    rate: number,
    active: boolean,
    playing: boolean,
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
    const { source } = clipTimes(item, rate, Math.max(this.frameNumber, item.startFrame));
    if (playing && item.endFrame > this.frameNumber) decoder.playing(source, this.speed);
    else if (item.endFrame > this.frameNumber) decoder.exact(source);
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

  private draw(scene: PreviewScene) {
    const context = this.context;
    if (context === null) return;
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
    type Layer = { readonly item: LaidOutClip; readonly pose: ClipPose } & (
      | { readonly kind: "text"; readonly words: string }
      | { readonly kind: "offline" }
      | {
          readonly kind: "picture";
          readonly drawable: CanvasImageSource;
          readonly width: number;
          readonly height: number;
        }
    );
    const layers: Array<Layer> = [];
    let signature = `${this.canvas.width}x${this.canvas.height}/${scene.frame.width}x${scene.frame.height}`;
    for (const { item, active } of this.clipsNear(scene, "Video")) {
      if (!active) continue;
      const { offset, source: sourceTime } = clipTimes(item, scene.layout.rate, this.frameNumber);
      const pose = poseAt(transformOf(item), offset);
      const source = this.source(scene, item);
      const posed = `|${item.key}@${pose.x},${pose.y},${pose.scale},${pose.rotation},${pose.opacity}`;
      if (source === undefined) {
        const words = graphicText(item);
        if (words === "") continue;
        layers.push({ item, pose, kind: "text", words });
        signature += `${posed}t${words}`;
        continue;
      }
      let drawable: CanvasImageSource | null = null;
      let naturalWidth = source.width ?? 0;
      let naturalHeight = source.height ?? 0;
      let stamp = "";
      if (source.still) {
        const still = this.image(source.still);
        drawable = still?.bitmap ?? null;
        naturalWidth ||= still?.width ?? 0;
        naturalHeight ||= still?.height ?? 0;
        stamp = "s";
      } else {
        const decoder = this.decoders.get(item.key);
        const slot = this.videos.get(item.key);
        const frame = decoder?.frameAt(sourceTime) ?? null;
        if (frame !== null) {
          drawable = frame;
          naturalWidth ||= frame.displayWidth;
          naturalHeight ||= frame.displayHeight;
          stamp = `f${frame.timestamp}`;
        } else if (slot && slot.element.readyState >= 2) {
          drawable = slot.element;
          naturalWidth ||= slot.element.videoWidth;
          naturalHeight ||= slot.element.videoHeight;
          stamp = `e${slot.element.currentTime}`;
        }
      }
      if (drawable === null || naturalWidth === 0) {
        const failed =
          this.videos.get(item.key)?.failed === true ||
          this.decoders.get(item.key)?.broken === true;
        if (failed || (!source.video && !source.still)) {
          layers.push({ item, pose, kind: "offline" });
          signature += `${posed}o`;
        }
        continue;
      }
      layers.push({
        item,
        pose,
        kind: "picture",
        drawable,
        width: naturalWidth,
        height: naturalHeight,
      });
      signature += `${posed}${stamp}`;
    }
    if (signature === this.drawn) return;
    this.drawn = signature;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.fillStyle = "#000";
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.save();
    context.beginPath();
    context.rect(left, top, width, height);
    context.clip();
    for (const layer of layers) {
      const { pose } = layer;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = Math.min(1, Math.max(0, pose.opacity));
      context.translate(left + pose.x * width, top + pose.y * height);
      context.rotate((pose.rotation * Math.PI) / 180);
      if (layer.kind === "text") {
        this.drawText(context, layer.words, {
          scale: pose.scale,
          width,
          height,
          anchor: graphicTextPosition(layer.item),
        });
      } else if (layer.kind === "offline") {
        this.drawOffline(context, layer.item.clip.name, height);
      } else {
        const w = layer.width * pose.scale * pixels;
        const h = layer.height * pose.scale * pixels;
        context.drawImage(layer.drawable, -w / 2, -h / 2, w, h);
      }
    }
    context.restore();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
  }

  /**
   * Draws a text graphic around its text layer's anchor, offset by the clip's Motion. Font and
   * size live in Premiere's style data, so this uses a bold sans at caption size. An anchor near
   * the left edge is a paragraph box spanning the frame symmetrically, so its text centres.
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
