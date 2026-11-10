import { indexMp4Video, type Mp4VideoIndex } from "./mp4Index";

/**
 * Decodes one clip's proxy with WebCodecs. Playing, it keeps a few frames decoded just ahead of
 * the playhead; paused or scrubbing, it decodes the exact frame from the nearest keyframe. Frames
 * are drawn straight from the decoder, so there is no media element to seek, buffer or steer.
 */

interface LoadedProxy {
  readonly buffer: ArrayBuffer;
  readonly index: Mp4VideoIndex;
}

// Proxies are a few MB each; a session keeps every one it has opened.
const proxies = new Map<string, Promise<LoadedProxy | null>>();

export const loadProxy = (url: string): Promise<LoadedProxy | null> => {
  let pending = proxies.get(url);
  if (pending === undefined) {
    pending = fetch(url)
      .then((response) => (response.ok ? response.arrayBuffer() : null))
      .then((buffer) => {
        const index = buffer === null ? null : indexMp4Video(buffer);
        return buffer !== null && index !== null ? { buffer, index } : null;
      })
      .catch(() => null);
    proxies.set(url, pending);
  }
  return pending;
};

export const webCodecsAvailable = () => typeof VideoDecoder !== "undefined";

// Frames held decoded ahead of the playhead. Hardware decoders have small frame pools and stall
// when callers hold too many, so this stays short.
const AHEAD_FRAMES = 6;
const MAX_QUEUE = 4;

export class ClipDecoder {
  private decoder: VideoDecoder | null = null;
  private frames: Array<VideoFrame> = [];
  /** Next sample to feed, in decode order. */
  private next = 0;
  /** True after a flush: the next chunk fed must be a keyframe, so playing restarts. */
  private flushed = false;
  private failed = false;
  /** The time the last exact (paused) request decoded up to. */
  private exactTarget = Number.NaN;
  /** An exact decode is flushing; newer requests wait in `queuedExact`, latest wins. */
  private exactBusy = false;
  private queuedExact = Number.NaN;
  /** The last picture drawn, kept across a restart so the layer never blanks while decoding. */
  private held: VideoFrame | null = null;
  private shown: VideoFrame | null = null;

  constructor(
    private readonly proxy: LoadedProxy,
    private readonly onFrame: () => void,
  ) {}

  get broken() {
    return this.failed;
  }

  private open() {
    // Resetting reuses the hardware decoder; creating one per seek is what made scrubbing stall.
    if (this.decoder !== null && this.decoder.state !== "closed") {
      this.decoder.reset();
    } else {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          this.frames.push(frame);
          this.frames.sort((a, b) => a.timestamp - b.timestamp);
          this.onFrame();
        },
        error: () => {
          this.failed = true;
          this.onFrame();
        },
      });
    }
    const keep = this.shown !== null && this.frames.includes(this.shown) ? this.shown : null;
    if (keep !== null) {
      this.held?.close();
      this.held = keep;
    }
    this.shown = null;
    for (const frame of this.frames) if (frame !== keep) frame.close();
    this.frames = [];
    this.decoder.configure({
      codec: this.proxy.index.codec,
      description: this.proxy.index.description,
      codedWidth: this.proxy.index.width,
      codedHeight: this.proxy.index.height,
      hardwareAcceleration: "prefer-hardware",
      optimizeForLatency: true,
    });
    this.flushed = false;
  }

  /** The decode-order index of the keyframe a decoder must start from to reach `time`. */
  private keyframeBefore(time: number) {
    const samples = this.proxy.index.samples;
    let start = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i]!;
      if (sample.time > time + 1e-4) {
        // Decode order runs ahead of presentation order only within a GOP, so the last
        // keyframe whose own time is at or before `time` starts the right GOP.
        if (sample.key) break;
        continue;
      }
      if (sample.key) start = i;
    }
    return start;
  }

  private feed(until: number) {
    const decoder = this.decoder;
    if (decoder === null) return;
    const samples = this.proxy.index.samples;
    while (this.next < samples.length && decoder.decodeQueueSize < MAX_QUEUE) {
      const sample = samples[this.next]!;
      if (sample.time > until && sample.key) break;
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.key ? "key" : "delta",
          timestamp: Math.round(sample.time * 1e6),
          duration: Math.round(sample.duration * 1e6),
          data: new Uint8Array(this.proxy.buffer, sample.offset, sample.size),
        }),
      );
      this.next++;
      // Stop once enough frames past `until` are queued to cover reordering.
      if (sample.time > until + sample.duration * 3) break;
    }
  }

  /** Drops frames before `time`, keeping the one on screen. */
  private trim(time: number) {
    while (this.frames.length > 1 && this.frames[1]!.timestamp <= time * 1e6 + 500) {
      const dropped = this.frames.shift();
      if (dropped === this.shown) this.shown = null;
      dropped?.close();
    }
  }

  private restart(time: number) {
    this.open();
    this.next = this.keyframeBefore(time);
  }

  /** Keeps frames decoded from `time` onward while playing forward. */
  playing(time: number, speed: number) {
    if (this.failed) return;
    const first = this.frames[0];
    const behind = first !== undefined && first.timestamp > time * 1e6 + 20_000;
    const far =
      this.next < this.proxy.index.samples.length &&
      (this.proxy.index.samples[this.next]?.time ?? 0) > time + 2;
    if (this.decoder === null || this.flushed || behind || far) this.restart(time);
    this.exactTarget = Number.NaN;
    this.queuedExact = Number.NaN;
    this.trim(time);
    const frameTime = this.proxy.index.samples[0]?.duration ?? 1 / 30;
    if (this.frames.length < AHEAD_FRAMES)
      this.feed(time + frameTime * AHEAD_FRAMES * Math.max(1, speed));
  }

  /** Decodes exactly the frame at `time` (paused, scrubbing, reverse). */
  exact(time: number) {
    if (this.failed) return;
    if (this.frameAt(time, true) !== null) {
      this.queuedExact = Number.NaN;
      return;
    }
    if (this.exactBusy) {
      this.queuedExact = time;
      return;
    }
    if (this.exactTarget === time) return;
    this.exactTarget = time;
    this.exactBusy = true;
    this.restart(time);
    const samples = this.proxy.index.samples;
    const decoder = this.decoder;
    if (decoder === null) return;
    // Feed the GOP up to the target, then flush so the decoder hands back every frame.
    while (this.next < samples.length) {
      const sample = samples[this.next]!;
      if (sample.key && sample.time > time + 1e-4 && this.next > 0) break;
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.key ? "key" : "delta",
          timestamp: Math.round(sample.time * 1e6),
          duration: Math.round(sample.duration * 1e6),
          data: new Uint8Array(this.proxy.buffer, sample.offset, sample.size),
        }),
      );
      this.next++;
    }
    this.flushed = true;
    const settle = () => {
      this.exactBusy = false;
      const queued = this.queuedExact;
      this.queuedExact = Number.NaN;
      if (!Number.isNaN(queued) && queued !== time) this.exact(queued);
      this.onFrame();
    };
    void decoder.flush().then(
      () => {
        this.trim(time);
        settle();
      },
      // A reset (playback starting) aborts the flush; let the same time decode again later.
      () => {
        this.exactTarget = Number.NaN;
        settle();
      },
    );
  }

  /** The frame on screen at `time`; with `exact`, only one whose span covers `time`. */
  frameAt(time: number, exact = false): VideoFrame | null {
    const at = time * 1e6;
    let found: VideoFrame | null = null;
    for (const frame of this.frames) {
      if (frame.timestamp <= at + 500) found = frame;
      else break;
    }
    if (!exact) {
      if (found === null) return this.held;
      this.shown = found;
      this.held?.close();
      this.held = null;
      return found;
    }
    if (found === null) return null;
    const end = found.timestamp + (found.duration ?? 0);
    return at < end + 500 ? found : null;
  }

  close() {
    for (const frame of this.frames) frame.close();
    this.frames = [];
    this.held?.close();
    this.held = null;
    this.shown = null;
    if (this.decoder !== null && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
  }
}
