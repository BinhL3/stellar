import type { ChunkGrid } from "./audioSchedule";
import {
  adtsStream,
  AUDIO_CHUNK_FRAMES,
  type AudioChunkSpan,
  audioChunkCount,
  audioChunkSpan,
  type AudioRange,
  indexMp4Audio,
  type Mp4AudioIndex,
  planAudioRanges,
} from "./mp4Audio";
import { locateMoov } from "./mp4Index";
import { assetIdentity, rangeBudget } from "./rangeBudget";

/**
 * A clip's sound, held as decoded chunks of a few seconds. The file is read by byte range
 * through the budget picture shares, decoded off the main thread a chunk at a time, and kept
 * in two bounded caches: the bytes as fetched, which are small, and the samples, which are not.
 */

// The first read: the whole file for most clips of a short (about 50 s of sound), and for a
// longer one its opening seconds, plus the index when the build put it first.
const HEAD_BYTES = 1024 * 1024;
// Chunks next to each other are read in one request up to this size, about 25 s of sound.
const FETCH_BYTES = 512 * 1024;
// Fetched bytes kept: about 25 minutes of sound, so going back over a stretch needs no request.
const ENCODED_CACHE_BYTES = 32 * 1024 * 1024;
// Decoded samples kept: about five and a half minutes of stereo at 48 kHz, most recent first.
const DECODED_CACHE_BYTES = 128 * 1024 * 1024;
// Samples a chunk holds past each end, which a join cross-fades over (5 ms at 48 kHz).
const GUARD_SAMPLES = 256;
const RETRY_AFTER_MS = 1000;
// Decodes waiting their turn; a scrub that has moved on drops the oldest.
const MAX_DECODE_QUEUE = 16;

/** Keeps entries up to a byte budget, dropping the least recently used first. */
export class ByteLru<K> {
  private readonly entries = new Map<K, { readonly bytes: number; readonly drop: () => void }>();
  private total = 0;

  constructor(readonly budget: number) {}

  get bytes() {
    return this.total;
  }

  /** Adds an entry as the most recent; `drop` is called if the budget later pushes it out. */
  add(key: K, bytes: number, drop: () => void) {
    this.delete(key);
    this.entries.set(key, { bytes, drop });
    this.total += bytes;
    for (const [old, entry] of this.entries) {
      if (this.total <= this.budget) break;
      if (old === key) continue;
      this.entries.delete(old);
      this.total -= entry.bytes;
      entry.drop();
    }
  }

  touch(key: K) {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  delete(key: K) {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.total -= entry.bytes;
  }
}

const encoded = new ByteLru<Uint8Array>(ENCODED_CACHE_BYTES);
const decoded = new ByteLru<AudioBuffer>(DECODED_CACHE_BYTES);

/** A chunk's samples, with where they sit in the file's own seconds. */
export interface DecodedChunk {
  readonly buffer: AudioBuffer;
  /** The same samples back to front, made the first time the chunk plays in reverse. */
  reversed: AudioBuffer | null;
  readonly start: number;
  readonly end: number;
}

const listeners = new Set<() => void>();
const tell = () => {
  for (const listener of listeners) listener();
};

/** Calls `listener` whenever a file opens or a chunk finishes decoding. */
export const onAudioReady = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const acquire = () =>
  new Promise<void>((resolve) => {
    const attempt = () => {
      if (rangeBudget.take("audio")) resolve();
      else rangeBudget.whenFree(attempt);
    };
    attempt();
  });

const fetchRange = async (url: string, start: number, end: number) => {
  await acquire();
  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=${start}-${Number.isFinite(end) ? end - 1 : ""}` },
    });
    if (!response.ok) return null;
    return { whole: response.status !== 206, bytes: await response.arrayBuffer() };
  } finally {
    rangeBudget.release("audio");
  }
};

interface Piece {
  /** Where `data` starts in the file. */
  readonly base: number;
  readonly data: Uint8Array;
}

/** One audio file: its frame index and the chunks of it in memory. */
export class AudioFile {
  readonly grid: ChunkGrid;
  /** The seconds of sound the file holds. */
  readonly start: number;
  readonly end: number;
  readonly chunks: number;
  private readonly pieces = new Map<number, Piece>();
  private readonly ready = new Map<number, DecodedChunk>();
  private readonly fetching = new Set<number>();
  readonly decoding = new Set<number>();
  /** Chunks that would not decode; they stay silent instead of being tried every frame. */
  readonly broken = new Set<number>();
  private retryAt = 0;

  constructor(
    /** The newest signed URL for the file; an older one stops working when it expires. */
    public url: string,
    readonly index: Mp4AudioIndex,
  ) {
    const { sampleRate, frameSamples, frames, origin } = index;
    this.grid = {
      origin,
      chunkSeconds: (AUDIO_CHUNK_FRAMES * frameSamples) / sampleRate,
      guardSeconds: GUARD_SAMPLES / sampleRate,
    };
    this.start = Math.max(0, origin);
    this.end = origin + (frames * frameSamples) / sampleRate;
    this.chunks = audioChunkCount(index);
  }

  /** Keeps the bytes of every chunk that `bytes`, the file from `base` on, holds whole. */
  keep(bytes: ArrayBuffer, base: number, from = 0, to = this.chunks - 1) {
    for (let chunk = from; chunk <= to; chunk++) {
      if (this.pieces.has(chunk)) continue;
      const span = audioChunkSpan(this.index, chunk);
      const at = span.offset - base;
      if (at < 0) continue;
      if (at + span.size > bytes.byteLength) break;
      const data = new Uint8Array(bytes.slice(at, at + span.size));
      this.pieces.set(chunk, { base: span.offset, data });
      encoded.add(data, data.byteLength, () => this.pieces.delete(chunk));
    }
  }

  /** A decoded chunk, or null while it isn't in memory. */
  chunk(index: number): DecodedChunk | null {
    const found = this.ready.get(index);
    if (found === undefined) return null;
    decoded.touch(found.buffer);
    if (found.reversed !== null) decoded.touch(found.reversed);
    return found;
  }

  /** A chunk's samples back to front, for media that plays in reverse. */
  reversedOf(chunk: DecodedChunk): AudioBuffer {
    if (chunk.reversed !== null) return chunk.reversed;
    const { buffer } = chunk;
    const reversed = new AudioBuffer({
      length: buffer.length,
      numberOfChannels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
    });
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      reversed.getChannelData(channel).set(buffer.getChannelData(channel));
      reversed.getChannelData(channel).reverse();
    }
    chunk.reversed = reversed;
    decoded.add(reversed, bufferBytes(reversed), () => {
      chunk.reversed = null;
    });
    return reversed;
  }

  chunkAt(seconds: number) {
    return Math.min(
      this.chunks - 1,
      Math.max(0, Math.floor((seconds - this.grid.origin) / this.grid.chunkSeconds)),
    );
  }

  /**
   * Makes chunks `from` to `decodeTo` ready to play and keeps the bytes of those up to
   * `fetchTo` on their way. Callers ask again while they still need them, so nothing queues
   * for a part of the file the playhead has left.
   */
  want(from: number, decodeTo: number, fetchTo = decodeTo) {
    const first = Math.max(0, Math.min(from, decodeTo));
    const last = Math.min(this.chunks - 1, Math.max(from, decodeTo));
    for (let chunk = first; chunk <= last; chunk++) {
      if (this.ready.has(chunk) || this.decoding.has(chunk) || this.broken.has(chunk)) continue;
      if (this.pieces.has(chunk)) enqueueDecode(this, chunk);
    }
    if (performance.now() < this.retryAt) return;
    const missing = (chunk: number) => !this.pieces.has(chunk) && !this.fetching.has(chunk);
    const until = Math.min(this.chunks - 1, Math.max(last, fetchTo));
    const since = Math.max(0, Math.min(first, fetchTo));
    for (const range of planAudioRanges(this.index, since, until, missing, FETCH_BYTES)) {
      if (!rangeBudget.take("audio")) {
        rangeBudget.whenFree(tell);
        return;
      }
      this.read(range, first, last);
    }
  }

  private read(range: AudioRange, decodeFrom: number, decodeTo: number) {
    for (let chunk = range.first; chunk <= range.last; chunk++) this.fetching.add(chunk);
    void fetch(this.url, {
      headers: { Range: `bytes=${range.offset}-${range.offset + range.size - 1}` },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const bytes = await response.arrayBuffer();
        // A server that ignores Range answers 200 with the whole file.
        this.keep(bytes, response.status === 206 ? range.offset : 0, range.first, range.last);
        for (let chunk = range.first; chunk <= range.last; chunk++) {
          if (chunk >= decodeFrom && chunk <= decodeTo) enqueueDecode(this, chunk);
        }
      })
      .catch(() => {
        this.retryAt = performance.now() + RETRY_AFTER_MS;
        // Nothing else brings a paused player back to ask again.
        setTimeout(tell, RETRY_AFTER_MS);
      })
      .finally(() => {
        rangeBudget.release("audio");
        for (let chunk = range.first; chunk <= range.last; chunk++) this.fetching.delete(chunk);
        tell();
      });
  }

  /** The bytes a chunk decodes from, or null once the cache has let them go. */
  piece(chunk: number): Piece | null {
    const piece = this.pieces.get(chunk);
    if (piece === undefined) return null;
    encoded.touch(piece.data);
    return piece;
  }

  hold(chunk: number, value: DecodedChunk) {
    this.ready.set(chunk, value);
    decoded.add(value.buffer, bufferBytes(value.buffer), () => this.ready.delete(chunk));
  }
}

const bufferBytes = (buffer: AudioBuffer) => buffer.length * buffer.numberOfChannels * 4;

// One decode at a time: a chunk takes a few milliseconds, and order is what matters.
const decodeQueue: Array<{ readonly file: AudioFile; readonly chunk: number }> = [];
let decodingNow = false;

const enqueueDecode = (file: AudioFile, chunk: number) => {
  if (file.decoding.has(chunk) || file.broken.has(chunk)) return;
  file.decoding.add(chunk);
  decodeQueue.push({ file, chunk });
  while (decodeQueue.length > MAX_DECODE_QUEUE) {
    const dropped = decodeQueue.shift();
    dropped?.file.decoding.delete(dropped.chunk);
  }
  void pumpDecode();
};

const pumpDecode = async () => {
  if (decodingNow) return;
  decodingNow = true;
  try {
    for (let job = decodeQueue.shift(); job !== undefined; job = decodeQueue.shift()) {
      const { file, chunk } = job;
      const piece = file.piece(chunk);
      const value = piece === null ? null : await decodeChunk(file, chunk, piece).catch(() => null);
      file.decoding.delete(chunk);
      if (value !== null) file.hold(chunk, value);
      else if (piece !== null) file.broken.add(chunk);
      tell();
    }
  } finally {
    decodingNow = false;
  }
};

let decoder: AudioDecoder | null = null;
let decoderFor: Mp4AudioIndex | null = null;
let sink: ((data: AudioData) => void) | null = null;
let decoderFailed = false;

/** Decodes a span's frames to planar samples with WebCodecs, off the main thread. */
const decodeWithCodec = async (
  index: Mp4AudioIndex,
  span: AudioChunkSpan,
  piece: Piece,
): Promise<Array<Float32Array> | null> => {
  const { frameSamples, sampleRate } = index;
  const total = (span.end - span.first) * frameSamples;
  const planes = Array.from({ length: index.channels }, () => new Float32Array(total));
  if (decoder === null || decoder.state === "closed" || decoderFor !== index) {
    if (decoder !== null && decoder.state !== "closed") decoder.close();
    decoderFailed = false;
    decoder = new AudioDecoder({
      output: (data) => {
        if (sink === null) data.close();
        else sink(data);
      },
      error: () => {
        decoderFailed = true;
      },
    });
    decoder.configure({
      codec: index.codec,
      sampleRate,
      numberOfChannels: index.channels,
      description: index.config,
    });
    decoderFor = index;
  }
  const micros = (frame: number) => Math.round(((frame * frameSamples) / sampleRate) * 1e6);
  let at = -1;
  let written = 0;
  sink = (data) => {
    // The first output says where the decoder starts; a decoder that drops its priming
    // moves the timestamp with it. The rest follow on.
    if (at < 0) {
      at = Math.max(0, Math.round(((data.timestamp - micros(span.first)) * sampleRate) / 1e6));
    }
    const count = data.numberOfFrames;
    if (at + count <= total) {
      for (let channel = 0; channel < planes.length; channel++) {
        data.copyTo(planes[channel]!.subarray(at, at + count), {
          planeIndex: Math.min(channel, data.numberOfChannels - 1),
          format: "f32-planar",
        });
      }
      written += count;
    }
    at += count;
    data.close();
  };
  for (let frame = span.first; frame < span.end; frame++) {
    const from = index.offsets[frame]! - piece.base;
    decoder.decode(
      new EncodedAudioChunk({
        type: "key",
        timestamp: micros(frame),
        duration: micros(1),
        data: piece.data.subarray(from, from + index.sizes[frame]!),
      }),
    );
  }
  await decoder.flush();
  sink = null;
  if (decoderFailed) {
    decoder = null;
    return null;
  }
  return written > 0 ? planes : null;
};

/** Decodes a span through `decodeAudioData`, for browsers with no WebCodecs audio decoder. */
const decodeWithContext = async (
  index: Mp4AudioIndex,
  span: AudioChunkSpan,
  piece: Piece,
): Promise<Array<Float32Array> | null> => {
  const context = new OfflineAudioContext(index.channels, 1, index.sampleRate);
  const stream = adtsStream(index, span, piece.data, piece.base);
  const buffer = await context.decodeAudioData(stream.buffer as ArrayBuffer);
  const total = (span.end - span.first) * index.frameSamples;
  // A decoder that trims its priming hands back fewer samples: they belong at the end.
  const shift = Math.max(0, total - buffer.length);
  return Array.from({ length: index.channels }, (_, channel) => {
    const plane = new Float32Array(total);
    const source = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
    plane.set(source.subarray(0, total - shift), shift);
    return plane;
  });
};

const codecAvailable = () => typeof AudioDecoder !== "undefined";

const decodeChunk = async (
  file: AudioFile,
  chunk: number,
  piece: Piece,
): Promise<DecodedChunk | null> => {
  const { index } = file;
  const { frameSamples, sampleRate } = index;
  const span = audioChunkSpan(index, chunk);
  const planes = codecAvailable()
    ? await decodeWithCodec(index, span, piece)
    : await decodeWithContext(index, span, piece);
  if (planes === null) return null;
  const decodedFrom = span.first * frameSamples;
  // A decoder started cold gets its first frame wrong, unless that is the file's own first.
  const valid = span.first === 0 ? 0 : decodedFrom + frameSamples;
  const chunkSamples = AUDIO_CHUNK_FRAMES * frameSamples;
  const low = Math.max(valid, chunk * chunkSamples - GUARD_SAMPLES);
  const high = Math.min(span.end * frameSamples, (chunk + 1) * chunkSamples + GUARD_SAMPLES);
  if (high <= low) return null;
  const buffer = new AudioBuffer({
    length: high - low,
    numberOfChannels: planes.length,
    sampleRate,
  });
  for (const [channel, plane] of planes.entries()) {
    buffer.getChannelData(channel).set(plane.subarray(low - decodedFrom, high - decodedFrom));
  }
  return {
    buffer,
    reversed: null,
    start: index.origin + low / sampleRate,
    end: index.origin + high / sampleRate,
  };
};

/** Reads a file's index, and the whole file when it is small enough to come with it. */
const openAudio = async (url: string): Promise<AudioFile | "unsupported" | null> => {
  const head = await fetchRange(url, 0, HEAD_BYTES);
  if (head === null) return null;
  const whole = head.whole || head.bytes.byteLength < HEAD_BYTES;
  let table = head.bytes;
  if (!whole) {
    const moov = locateMoov(head.bytes);
    if (moov === null) return "unsupported";
    if (moov.end > head.bytes.byteLength) {
      // The index sits after the sound, as ffmpeg leaves it, or runs past the head.
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
  }
  const index = indexMp4Audio(table);
  if (index === null || index.frames === 0) return "unsupported";
  // Sound interleaved with picture would be fetched with the picture between its frames.
  const span =
    index.offsets[index.frames - 1]! + index.sizes[index.frames - 1]! - index.offsets[0]!;
  let bytes = 0;
  for (const size of index.sizes) bytes += size;
  if (span > bytes * 1.25 + 65536) return "unsupported";
  const file = new AudioFile(url, index);
  file.keep(head.bytes, 0);
  return file;
};

interface CachedAudio {
  file: AudioFile | null;
  /** The file can never play here: not an MP4 with AAC by itself. */
  unsupported: boolean;
  loading: boolean;
  retryAt: number;
}
const files = new Map<string, CachedAudio>();

/**
 * The file at `url` once its index is read; null while it loads, and for a file that can't
 * play. Asking is what starts the load, and a failed one is tried again after a moment.
 */
export const audioFile = (url: string): AudioFile | null => {
  const identity = assetIdentity(url);
  let cached = files.get(identity);
  if (cached === undefined) {
    cached = { file: null, unsupported: false, loading: false, retryAt: 0 };
    files.set(identity, cached);
  }
  if (cached.file !== null) {
    cached.file.url = url;
    return cached.file;
  }
  if (cached.unsupported || cached.loading || performance.now() < cached.retryAt) return null;
  const entry = cached;
  entry.loading = true;
  void openAudio(url)
    .catch(() => null)
    .then((opened) => {
      entry.loading = false;
      if (opened === "unsupported") entry.unsupported = true;
      else if (opened === null) {
        entry.retryAt = performance.now() + RETRY_AFTER_MS;
        setTimeout(tell, RETRY_AFTER_MS);
      } else entry.file = opened;
      tell();
    });
  return null;
};
