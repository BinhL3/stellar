import {
  indexMp4Video,
  keyframeBefore,
  keyframesOf,
  locateMoov,
  type Mp4Range,
  type Mp4Segment,
  type Mp4VideoIndex,
  planRanges,
  planSegments,
  segmentOf,
} from "./mp4Index";

/**
 * Decodes one clip's proxy with WebCodecs. Playing, it keeps a few frames decoded just ahead of
 * the playhead; paused or scrubbing, it decodes the exact frame from the nearest keyframe. Frames
 * are drawn straight from the decoder, so there is no media element to seek, buffer or steer.
 */

/** Bytes of the file held in memory, at `base` in the file. */
interface Held {
  readonly base: number;
  readonly bytes: Uint8Array;
}

// The first read. A proxy this size or smaller (most clips of a short) arrives whole in that one
// request, as it always did; a larger one gives up its index and its opening seconds.
const HEAD_BYTES = 4 * 1024 * 1024;
// Larger proxies are read in pieces of about this size (a few seconds), cut at keyframes.
const SEGMENT_BYTES = 1024 * 1024;
// Up to this size the rest of a proxy follows the head in the background, so a clip of a
// minute or so still ends up wholly in memory and seeks without a fetch.
const WHOLE_BYTES = 24 * 1024 * 1024;
// Neighbouring segments are read in one request up to this size.
const RANGE_BYTES = 8 * 1024 * 1024;
// Ranges fetched at once for all proxies. The browser allows six connections to the server,
// and each clip's audio element can hold one open for as long as it buffers.
const RANGE_PARALLEL = 3;
// The most recently used pieces stay in memory up to this many bytes (about 40 minutes of
// footage), so an hour-long project doesn't hold every proxy at once.
const PROXY_CACHE_BYTES = 768 * 1024 * 1024;
// Background fetches run a few at a time: dozens at once starve the clip under the playhead,
// which loads straight away, on a slow drive or a remote connection.
const PREFETCH_PARALLEL = 3;
const RETRY_AFTER_MS = 1000;

// In least-recently-used order. Indexes are not counted: a sample table is a few MB an hour.
const held = new Map<Held, { readonly owner: LoadedProxy; readonly segment: number }>();
let cachedBytes = 0;
let ranging = 0;
// Proxies whose request found every slot taken; they are told when one frees up.
const starved = new Set<LoadedProxy>();

const hold = (owner: LoadedProxy, segment: number, piece: Held) => {
  held.set(piece, { owner, segment });
  cachedBytes += piece.bytes.byteLength;
  for (const [old, { owner: from, segment: at }] of held) {
    if (cachedBytes <= PROXY_CACHE_BYTES) break;
    if (old === piece) continue;
    held.delete(old);
    cachedBytes -= old.bytes.byteLength;
    from.drop(at);
  }
};

/**
 * One proxy file: its sample index, and the parts of it in memory. Decoders ask for the bytes
 * of a sample and for the segments they are about to need; what isn't held is fetched by byte
 * range and everyone listening is told when it lands.
 */
class LoadedProxy {
  readonly segments: ReadonlyArray<Mp4Segment>;
  readonly keys: Int32Array;
  private readonly pieces = new Map<number, Held>();
  private readonly fetching = new Set<number>();
  private readonly listeners = new Set<() => void>();
  private retryAt = 0;
  private lastUsed = -1;
  /** The rest of a mid-sized file is still to be read in the background, one range at a time. */
  private filling: boolean;
  private fillBusy = false;

  constructor(
    /** The newest signed URL for the file; an older one stops working when it expires. */
    public url: string,
    readonly index: Mp4VideoIndex,
    head: ArrayBuffer,
    whole: boolean,
  ) {
    this.keys = keyframesOf(index.samples);
    this.segments = planSegments(index.samples, whole ? Number.POSITIVE_INFINITY : SEGMENT_BYTES);
    const last = this.segments.at(-1);
    this.filling = !whole && last !== undefined && last.offset + last.size <= WHOLE_BYTES;
    if (whole) {
      if (last !== undefined) this.keep(0, head, 0);
      return;
    }
    for (const [i, segment] of this.segments.entries()) {
      if (segment.offset + segment.size > head.byteLength) break;
      this.keep(i, head.slice(segment.offset, segment.offset + segment.size), segment.offset);
    }
    this.want(0, -1);
  }

  private keep(segment: number, bytes: ArrayBuffer, base: number) {
    if (this.pieces.has(segment)) return;
    const piece = { base, bytes: new Uint8Array(bytes) };
    this.pieces.set(segment, piece);
    hold(this, segment, piece);
  }

  /** Called when the cache lets a piece go. */
  drop(segment: number) {
    this.pieces.delete(segment);
  }

  has(segment: number) {
    return this.pieces.has(segment);
  }

  /** The bytes of one sample, or null while its segment isn't in memory. */
  sample(index: number, segment: number): Uint8Array | null {
    const piece = this.pieces.get(segment);
    if (piece === undefined) return null;
    if (segment !== this.lastUsed) {
      // Moves the piece to the fresh end of the cache; once per segment, not per sample.
      this.lastUsed = segment;
      const entry = held.get(piece);
      if (entry !== undefined) {
        held.delete(piece);
        held.set(piece, entry);
      }
    }
    const sample = this.index.samples[index]!;
    return piece.bytes.subarray(
      sample.offset - piece.base,
      sample.offset - piece.base + sample.size,
    );
  }

  /**
   * Fetches the segments `from` to `to` that aren't here or on their way. Callers ask again on
   * every tick while they still need them, so what doesn't fit now is not queued: a scrub that
   * has moved on never waits behind ranges it left.
   */
  want(from: number, to: number) {
    if (performance.now() < this.retryAt) return;
    const missing = (segment: number) => !this.pieces.has(segment) && !this.fetching.has(segment);
    for (const range of planRanges(this.segments, from, to, missing, RANGE_BYTES)) {
      if (ranging >= RANGE_PARALLEL) {
        starved.add(this);
        return;
      }
      this.read(range, false);
    }
    if (!this.filling || this.fillBusy || ranging >= RANGE_PARALLEL) return;
    const [next] = planRanges(this.segments, 0, this.segments.length - 1, missing, RANGE_BYTES);
    if (next === undefined) this.filling = false;
    else this.read(next, true);
  }

  private read(range: Mp4Range, fill: boolean) {
    ranging += 1;
    if (fill) this.fillBusy = true;
    for (let i = range.first; i <= range.last; i++) this.fetching.add(i);
    void fetch(this.url, {
      headers: { Range: `bytes=${range.offset}-${range.offset + range.size - 1}` },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const bytes = await response.arrayBuffer();
        // A server that ignores Range answers 200 with the whole file.
        const base = response.status === 206 ? range.offset : 0;
        for (let i = range.first; i <= range.last; i++) {
          const segment = this.segments[i]!;
          const start = segment.offset - base;
          if (start + segment.size > bytes.byteLength) throw new Error("short range");
          this.keep(
            i,
            range.first === range.last && start === 0 && bytes.byteLength === segment.size
              ? bytes
              : bytes.slice(start, start + segment.size),
            segment.offset,
          );
        }
      })
      .catch(() => {
        this.retryAt = performance.now() + RETRY_AFTER_MS;
        // Nothing else brings a paused player back to ask again.
        setTimeout(() => this.tell(), RETRY_AFTER_MS);
      })
      .finally(() => {
        ranging -= 1;
        if (fill) this.fillBusy = false;
        for (let i = range.first; i <= range.last; i++) this.fetching.delete(i);
        if (this.filling) this.want(0, -1);
        this.tell();
        const waiting = [...starved];
        starved.clear();
        for (const proxy of waiting) if (proxy !== this) proxy.tell();
      });
  }

  private tell() {
    for (const listener of this.listeners) listener();
  }

  listen(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

interface CachedProxy {
  pending: Promise<LoadedProxy | null>;
  loaded: LoadedProxy | null;
}
// By the file's address without its signed token, which changes when the URL is renewed.
const proxies = new Map<string, CachedProxy>();
let prefetchQueue: Array<string> = [];
let prefetching = 0;

const identityOf = (url: string) => url.replace(/\/api\/assets\/[^/]+\//, "/api/assets/-/");

const fetchRange = async (url: string, start: number, end: number) => {
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${Number.isFinite(end) ? end - 1 : ""}` },
  });
  if (!response.ok) return null;
  return { whole: response.status !== 206, bytes: await response.arrayBuffer() };
};

/** Reads a proxy's index, and the whole file when it is small enough to come with it. */
const openProxy = async (url: string): Promise<LoadedProxy | null> => {
  const head = await fetchRange(url, 0, HEAD_BYTES);
  if (head === null) return null;
  // Short of what was asked for, or not a ranged answer at all: this is the whole file.
  if (head.whole || head.bytes.byteLength < HEAD_BYTES) {
    const index = indexMp4Video(head.bytes);
    return index === null ? null : new LoadedProxy(url, index, head.bytes, true);
  }
  const moov = locateMoov(head.bytes);
  if (moov === null) return null;
  let table = head.bytes;
  if (moov.end > head.bytes.byteLength) {
    // The index runs past the head (hours of footage), or sits after the media.
    const from = Math.max(moov.start, head.bytes.byteLength);
    const rest = await fetchRange(url, from, moov.end);
    if (rest === null) return null;
    if (rest.whole || from === moov.start) table = rest.bytes;
    else {
      const joined = new Uint8Array(moov.end - moov.start);
      joined.set(new Uint8Array(head.bytes, moov.start));
      joined.set(new Uint8Array(rest.bytes), head.bytes.byteLength - moov.start);
      table = joined.buffer;
    }
  }
  const index = indexMp4Video(table);
  return index === null ? null : new LoadedProxy(url, index, head.bytes, false);
};

export const loadProxy = (url: string): Promise<LoadedProxy | null> => {
  const identity = identityOf(url);
  const cached = proxies.get(identity);
  if (cached !== undefined) {
    if (cached.loaded !== null) cached.loaded.url = url;
    return cached.pending;
  }
  const entry: CachedProxy = { pending: Promise.resolve(null), loaded: null };
  entry.pending = openProxy(url)
    .catch(() => null)
    .then((loaded) => {
      entry.loaded = loaded;
      // Not cached, so a proxy that wasn't ready yet loads the next time it's needed.
      if (loaded === null && proxies.get(identity) === entry) proxies.delete(identity);
      return loaded;
    });
  proxies.set(identity, entry);
  return entry.pending;
};

const pumpPrefetch = () => {
  while (prefetching < PREFETCH_PARALLEL) {
    // Half the budget stays free for what the playhead reaches on its own.
    if (cachedBytes >= PROXY_CACHE_BYTES / 2) return;
    const url = prefetchQueue.shift();
    if (url === undefined) return;
    if (proxies.has(identityOf(url))) continue;
    prefetching += 1;
    void loadProxy(url).finally(() => {
      prefetching -= 1;
      pumpPrefetch();
    });
  }
};

/** Fetches proxies in the background, in the order given; a new call replaces what's waiting. */
export const prefetchProxies = (urls: ReadonlyArray<string>) => {
  prefetchQueue = urls.filter((url) => {
    const loaded = proxies.get(identityOf(url))?.loaded;
    // A renewed URL replaces the one the proxy was opened with.
    if (loaded !== null && loaded !== undefined) loaded.url = url;
    return !proxies.has(identityOf(url));
  });
  pumpPrefetch();
};

export const webCodecsAvailable = () => typeof VideoDecoder !== "undefined";

// Frames held decoded ahead of the playhead. Hardware decoders have small frame pools and stall
// when callers hold too many, so this stays short.
const AHEAD_FRAMES = 6;
const MAX_QUEUE = 4;
// Playing, this much of the file past the playhead is kept on its way, so a remote connection
// has time to deliver it before it is needed.
const READ_AHEAD_SECONDS = 10;
// A decoder this far behind the playhead (it waited on a range) jumps instead of catching up.
const STALLED_SECONDS = 1;

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
  /** The segment the last sample read was in, and the samples it spans. */
  private segment = 0;
  private segmentFirst = 0;
  private segmentEnd = 0;
  private lastExact = Number.NaN;
  private readonly unlisten: () => void;

  constructor(
    private readonly proxy: LoadedProxy,
    private readonly onFrame: () => void,
  ) {
    // A range landing is a reason to look again, like a decoded frame.
    this.unlisten = proxy.listen(onFrame);
  }

  /** The bytes of a sample; while its segment isn't in memory, asks for it and returns null. */
  private data(index: number): Uint8Array | null {
    if (index < this.segmentFirst || index >= this.segmentEnd) {
      this.segment = segmentOf(this.proxy.segments, index);
      const span = this.proxy.segments[this.segment];
      this.segmentFirst = span?.first ?? 0;
      this.segmentEnd = span?.end ?? 0;
    }
    const bytes = this.proxy.sample(index, this.segment);
    if (bytes === null) this.proxy.want(this.segment, this.segment);
    return bytes;
  }

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
    return keyframeBefore(this.proxy.index.samples, this.proxy.keys, time);
  }

  private feed(until: number) {
    const decoder = this.decoder;
    if (decoder === null) return;
    const samples = this.proxy.index.samples;
    while (this.next < samples.length && decoder.decodeQueueSize < MAX_QUEUE) {
      const sample = samples[this.next]!;
      if (sample.time > until && sample.key) break;
      const data = this.data(this.next);
      if (data === null) break;
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.key ? "key" : "delta",
          timestamp: Math.round(sample.time * 1e6),
          duration: Math.round(sample.duration * 1e6),
          data,
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
    const upNext =
      this.next < this.proxy.index.samples.length
        ? (this.proxy.index.samples[this.next]?.time ?? 0)
        : Number.NaN;
    const far = upNext > time + 2;
    const stalled = upNext < time - STALLED_SECONDS;
    if (this.decoder === null || this.flushed || behind || far || stalled) this.restart(time);
    this.exactTarget = Number.NaN;
    this.queuedExact = Number.NaN;
    this.lastExact = Number.NaN;
    if (this.proxy.segments.length > 1) {
      const segments = this.proxy.segments;
      const ahead = time + READ_AHEAD_SECONDS * Math.max(1, speed);
      this.proxy.want(
        segmentOf(segments, this.keyframeBefore(time)),
        segmentOf(segments, this.keyframeBefore(ahead)),
      );
    }
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
    if (this.proxy.segments.length > 1) {
      const segment = segmentOf(this.proxy.segments, this.keyframeBefore(time));
      // The next one in the direction of travel follows, so stepping and reverse don't wait.
      const onward = Math.max(0, segment + (time < this.lastExact ? -1 : 1));
      this.lastExact = time;
      if (!this.proxy.has(segment)) {
        this.proxy.want(segment, segment);
        return;
      }
      this.proxy.want(onward, onward);
    }
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
      const data = this.data(this.next);
      if (data === null) break;
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.key ? "key" : "delta",
          timestamp: Math.round(sample.time * 1e6),
          duration: Math.round(sample.duration * 1e6),
          data,
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
    this.unlisten();
    for (const frame of this.frames) frame.close();
    this.frames = [];
    this.held?.close();
    this.held = null;
    this.shown = null;
    if (this.decoder !== null && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
  }
}
