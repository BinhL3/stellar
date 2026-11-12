import {
  type ClipAudio,
  emptyCue,
  type OriginalCue,
  originalCue,
  originalsNear,
} from "./audioSchedule";
import { follow, releaseMedia } from "./mediaFollow";
import { assetIdentity, rangeBudget } from "./rangeBudget";

/**
 * Sound for clips whose rendition does not exist yet (the proxy build has not reached them,
 * failed, or has no ffmpeg): the original file through a media element, steered toward the
 * transport every animation frame and mixed into the same bus as everything else. It is close,
 * not exact, and only for forward play; the rendition takes over when it appears.
 */

// An element holds a connection for as long as its file is loaded, so only this many clips
// play from originals at once. `rangeBudget` counts them, out of picture's share.
const MAX_ORIGINALS = 2;
// Clips this far ahead get their element early, so it has loaded by the cut.
const WARM_SECONDS = 3;
const LEVEL_SMOOTH_SECONDS = 0.005;

interface Slot {
  readonly element: HTMLAudioElement;
  readonly gain: GainNode;
  /** The clip it plays; null while it only keeps its file loaded for the next clip of it. */
  key: string | null;
  url: string;
  /** The loaded file without its token; empty when nothing is loaded. */
  identity: string;
  failed: boolean;
  level: number;
  /** Where it was last sent while paused, so it is not sent there again every frame. */
  wanted: number;
}

export class OriginalSound {
  private readonly slots: Array<Slot> = [];
  private readonly near: Array<ClipAudio> = [];
  private readonly cue = emptyCue();
  /** Clips under the playhead playing from their original, and those left with no sound. */
  heard = 0;
  silent = 0;

  constructor(
    private readonly context: AudioContext,
    private readonly into: AudioNode,
  ) {}

  /** Whether any file is loaded: with none, and no clip to play, a frame has nothing to do. */
  get loaded() {
    for (const slot of this.slots) if (slot.identity !== "") return true;
    return false;
  }

  /**
   * Points the elements at the playhead: `frame`, moving `fps` timeline frames a second (0
   * when paused). `sorted` is every clip with no rendition, by where it comes in.
   */
  sync(
    sorted: ReadonlyArray<ClipAudio>,
    urls: (target: string) => string | null,
    frame: number,
    fps: number,
    rate: number,
  ) {
    const count = originalsNear(sorted, frame, WARM_SECONDS * rate, this.near);
    const picked = Math.min(count, MAX_ORIGINALS);
    for (const slot of this.slots) {
      if (slot.key === null) continue;
      let keep = false;
      for (let index = 0; index < picked; index++) {
        const plan = this.near[index]!;
        if (plan.key === slot.key && this.holds(slot, urls(plan.target))) keep = true;
      }
      if (!keep) this.rest(slot);
    }
    let heard = 0;
    let silent = 0;
    for (let index = 0; index < count; index++) {
      const plan = this.near[index]!;
      const under = fps !== 0 && plan.from <= frame && frame < plan.to;
      const url = urls(plan.target);
      const slot = index < picked && url !== null ? this.slotFor(plan.key, url) : null;
      if (slot === null || slot.failed) {
        if (under) silent += 1;
        continue;
      }
      if (under) heard += 1;
      this.steer(slot, originalCue(plan, frame, fps, rate, this.cue));
    }
    // A file no clip near the playhead plays is closed, which gives its connection back.
    for (const slot of this.slots) {
      if (slot.key !== null || slot.identity === "") continue;
      let useful = false;
      for (let index = 0; index < count && !slot.failed; index++) {
        if (this.holds(slot, urls(this.near[index]!.target))) useful = true;
      }
      if (!useful) this.unload(slot);
    }
    this.near.length = 0;
    this.heard = heard;
    this.silent = silent;
  }

  /** Pauses everything; the files stay loaded until the next `sync` decides. */
  pause() {
    for (const slot of this.slots) if (slot.key !== null) this.rest(slot);
    this.heard = 0;
    this.silent = 0;
  }

  destroy() {
    for (const slot of this.slots) {
      if (slot.identity !== "") this.unload(slot);
      slot.gain.disconnect();
    }
    this.slots.length = 0;
  }

  /** Whether a slot has `url`'s file loaded; a renewed token is the same file. */
  private holds(slot: Slot, url: string | null) {
    if (url === null || slot.identity === "") return false;
    if (slot.url === url) return true;
    if (slot.identity !== assetIdentity(url)) return false;
    slot.url = url;
    return true;
  }

  private slotFor(key: string, url: string): Slot | null {
    let spare: Slot | null = null;
    let loaded: Slot | null = null;
    for (const slot of this.slots) {
      if (slot.key === key) return slot;
      if (slot.key !== null) continue;
      // The file the clip before it played: a cut inside one file is then a seek, not a load.
      if (loaded === null && !slot.failed && this.holds(slot, url)) loaded = slot;
      else if (spare === null || slot.identity === "") spare = slot;
    }
    let slot = loaded;
    if (slot === null) {
      slot = spare ?? (this.slots.length < MAX_ORIGINALS ? this.create() : null);
      if (slot === null) return null;
      if (slot.identity !== "") this.unload(slot);
      // No connection to spare this frame; the next one asks again.
      if (!rangeBudget.take("original")) return null;
      slot.url = url;
      slot.identity = assetIdentity(url);
      slot.element.src = url;
    }
    slot.key = key;
    slot.wanted = Number.NaN;
    return slot;
  }

  private create(): Slot {
    const element = new Audio();
    // Routing a cross-origin element into Web Audio needs CORS, or it plays silence.
    element.crossOrigin = "anonymous";
    element.preload = "auto";
    const gain = new GainNode(this.context, { gain: 0 });
    this.context.createMediaElementSource(element).connect(gain).connect(this.into);
    const slot: Slot = {
      element,
      gain,
      key: null,
      url: "",
      identity: "",
      failed: false,
      level: 0,
      wanted: Number.NaN,
    };
    element.addEventListener("error", () => {
      if (slot.identity !== "") slot.failed = true;
    });
    this.slots.push(slot);
    return slot;
  }

  private setLevel(slot: Slot, level: number) {
    if (level === slot.level) return;
    slot.level = level;
    slot.gain.gain.setTargetAtTime(level, this.context.currentTime, LEVEL_SMOOTH_SECONDS);
  }

  private steer(slot: Slot, cue: OriginalCue) {
    const { element } = slot;
    this.setLevel(slot, cue.level);
    if (cue.mode === "wait") {
      if (!element.paused) element.pause();
      if (!(Math.abs(slot.wanted - cue.at) <= 1 / 240)) {
        slot.wanted = cue.at;
        element.currentTime = cue.at;
      }
      return;
    }
    slot.wanted = Number.NaN;
    if (element.paused) {
      // Waiting at its run-up point already, so starting needs no seek (and no stall).
      if (Math.abs(element.currentTime - cue.at) > 0.05) element.currentTime = cue.at;
      void element.play().catch(() => undefined);
    } else {
      follow(element, cue.at, cue.speed);
    }
  }

  private rest(slot: Slot) {
    slot.key = null;
    this.setLevel(slot, 0);
    if (!slot.element.paused) slot.element.pause();
  }

  private unload(slot: Slot) {
    releaseMedia(slot.element);
    rangeBudget.release("original");
    slot.key = null;
    slot.url = "";
    slot.identity = "";
    slot.failed = false;
  }
}
