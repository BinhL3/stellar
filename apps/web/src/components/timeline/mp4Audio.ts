import { child, readBoxes } from "./mp4Index";

/**
 * The AAC track of an MP4, read from its boxes, so the player can fetch any stretch of a clip's
 * sound by byte range and decode it itself. Written for the `.m4a` the proxy build makes, and
 * it reads an original `.mp4` or `.mov` with an AAC track the same way.
 */

export interface Mp4AudioIndex {
  /** As WebCodecs names it, such as `mp4a.40.2` for AAC-LC. */
  readonly codec: string;
  /** The AudioSpecificConfig, which a decoder is configured with. */
  readonly config: Uint8Array;
  readonly objectType: number;
  readonly frequencyIndex: number;
  readonly channelConfig: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Samples every frame decodes to: 1024 for AAC-LC. */
  readonly frameSamples: number;
  readonly frames: number;
  /** Where each frame's bytes sit in the file, and how many there are. */
  readonly offsets: Float64Array;
  readonly sizes: Uint32Array;
  /**
   * The presentation second of the first decoded sample. Negative by the encoder's priming
   * (1024 samples from ffmpeg), which the edit list says to skip, and later by any empty edit.
   */
  readonly origin: number;
}

const fourcc = (view: DataView, at: number) =>
  String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );

const FREQUENCIES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** Reads an MPEG-4 descriptor's tag and length (7 bits a byte) at `at`. */
const descriptor = (view: DataView, at: number, end: number) => {
  if (at + 2 > end) return null;
  const tag = view.getUint8(at);
  let length = 0;
  let cursor = at + 1;
  for (let i = 0; i < 4 && cursor < end; i++) {
    const byte = view.getUint8(cursor++);
    length = (length << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return { tag, body: cursor, end: Math.min(end, cursor + length) };
};

/** The AudioSpecificConfig inside an `esds` box's payload, or null. */
const audioConfig = (view: DataView, start: number, end: number): Uint8Array | null => {
  // Version and flags, then ES_Descriptor > DecoderConfigDescriptor > DecoderSpecificInfo.
  const es = descriptor(view, start + 4, end);
  if (es === null || es.tag !== 0x03) return null;
  const flags = view.getUint8(es.body + 2);
  let at = es.body + 3;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + view.getUint8(at);
  if (flags & 0x20) at += 2;
  const decoder = descriptor(view, at, es.end);
  if (decoder === null || decoder.tag !== 0x04) return null;
  const specific = descriptor(view, decoder.body + 13, decoder.end);
  if (specific === null || specific.tag !== 0x05 || specific.end <= specific.body) return null;
  return new Uint8Array(view.buffer.slice(specific.body, specific.end));
};

/** Parses the first AAC track of an MP4 whose `moov` is in `buffer`. */
export function indexMp4Audio(buffer: ArrayBuffer): Mp4AudioIndex | null {
  const view = new DataView(buffer);
  const moov = readBoxes(view, 0, buffer.byteLength).find((box) => box.type === "moov");
  if (moov === undefined) return null;
  const mvhd = child(view, moov, "mvhd");
  const movieScale =
    mvhd === undefined
      ? 1000
      : view.getUint32(mvhd.body + (view.getUint8(mvhd.body) === 1 ? 20 : 12));
  for (const trak of readBoxes(view, moov.body, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdia = child(view, trak, "mdia");
    const hdlr = child(view, mdia, "hdlr");
    if (hdlr === undefined || fourcc(view, hdlr.body + 8) !== "soun") continue;
    const mdhd = child(view, mdia, "mdhd");
    const stbl = child(view, child(view, mdia, "minf"), "stbl");
    const stsd = child(view, stbl, "stsd");
    if (mdhd === undefined || stbl === undefined || stsd === undefined) continue;
    const timescale = view.getUint32(mdhd.body + (view.getUint8(mdhd.body) === 1 ? 20 : 12));

    const entry = readBoxes(view, stsd.body + 8, stsd.end)[0];
    if (entry === undefined || entry.type !== "mp4a") continue;
    // QuickTime nests `esds` in a `wave` box at a version-dependent depth, so look for its name.
    let config: Uint8Array | null = null;
    for (let at = entry.body; at + 8 <= entry.end; at++) {
      if (fourcc(view, at) !== "esds") continue;
      config = audioConfig(view, at + 4, Math.min(entry.end, at - 4 + view.getUint32(at - 4)));
      break;
    }
    if (config === null || config.length < 2) continue;
    let objectType = config[0]! >> 3;
    let frequencyIndex = ((config[0]! & 7) << 1) | (config[1]! >> 7);
    let channelConfig = (config[1]! >> 3) & 15;
    // Escaped object types and explicit rates are not what an editor's sources carry.
    if (objectType === 31 || frequencyIndex === 15) continue;
    const sampleRate = FREQUENCIES[frequencyIndex];
    if (sampleRate === undefined || channelConfig === 0) continue;

    const stts = child(view, stbl, "stts");
    const stsz = child(view, stbl, "stsz");
    const stsc = child(view, stbl, "stsc");
    const chunkOffsets = child(view, stbl, "stco") ?? child(view, stbl, "co64");
    if (!stts || !stsz || !stsc || !chunkOffsets) continue;
    if (view.getUint32(stts.body + 4) === 0) continue;
    const frameSamples = Math.round((view.getUint32(stts.body + 12) * sampleRate) / timescale);
    if (frameSamples <= 0) continue;

    const frames = view.getUint32(stsz.body + 8);
    const fixedSize = view.getUint32(stsz.body + 4);
    const sizes = new Uint32Array(frames);
    for (let i = 0; i < frames; i++) {
      sizes[i] = fixedSize !== 0 ? fixedSize : view.getUint32(stsz.body + 12 + i * 4);
    }
    const wide = chunkOffsets.type === "co64";
    const chunkCount = view.getUint32(chunkOffsets.body + 4);
    const chunkOffset = (chunk: number) =>
      wide
        ? Number(view.getBigUint64(chunkOffsets.body + 8 + chunk * 8))
        : view.getUint32(chunkOffsets.body + 8 + chunk * 4);
    const offsets = new Float64Array(frames);
    const runs = view.getUint32(stsc.body + 4);
    let frame = 0;
    for (let i = 0; i < runs; i++) {
      const firstChunk = view.getUint32(stsc.body + 8 + i * 12) - 1;
      const perChunk = view.getUint32(stsc.body + 12 + i * 12);
      const lastChunk =
        i + 1 < runs ? view.getUint32(stsc.body + 8 + (i + 1) * 12) - 1 : chunkCount;
      for (let chunk = firstChunk; chunk < lastChunk && frame < frames; chunk++) {
        let at = chunkOffset(chunk);
        for (let j = 0; j < perChunk && frame < frames; j++) {
          offsets[frame] = at;
          at += sizes[frame]!;
          frame++;
        }
      }
    }

    // Empty edits delay the track; the first real one names the priming samples to skip.
    let delay = 0;
    let priming = 0;
    const elst = child(view, child(view, trak, "edts"), "elst");
    if (elst !== undefined) {
      const version = view.getUint8(elst.body);
      const entries = view.getUint32(elst.body + 4);
      const width = version === 1 ? 20 : 12;
      for (let i = 0; i < entries; i++) {
        const at = elst.body + 8 + i * width;
        if (at + width > elst.end) break;
        const duration = version === 1 ? Number(view.getBigUint64(at)) : view.getUint32(at);
        const mediaTime = version === 1 ? Number(view.getBigInt64(at + 8)) : view.getInt32(at + 4);
        if (mediaTime < 0) {
          delay += duration / movieScale;
          continue;
        }
        priming = mediaTime / timescale;
        break;
      }
    }

    return {
      codec: `mp4a.40.${objectType}`,
      config,
      objectType,
      frequencyIndex,
      channelConfig,
      sampleRate,
      channels: channelConfig === 7 ? 8 : channelConfig,
      frameSamples,
      frames,
      offsets,
      sizes,
      origin: delay - priming,
    };
  }
  return null;
}

/** Frames decoded as one piece: 128 AAC frames are about 2.7 s at 48 kHz. */
export const AUDIO_CHUNK_FRAMES = 128;
/**
 * Frames decoded before a chunk and thrown away. An AAC frame overlaps the one before it, so
 * a decoder started cold gets its first frame wrong; the second makes the guard samples.
 */
const PREROLL_FRAMES = 2;
const POSTROLL_FRAMES = 1;

export const audioChunkCount = (index: Mp4AudioIndex) =>
  Math.ceil(index.frames / AUDIO_CHUNK_FRAMES);

export interface AudioChunkSpan {
  /** The frames to decode for a chunk, with its pre-roll and post-roll: `first` up to `end`. */
  readonly first: number;
  readonly end: number;
  /** The byte range that holds them. */
  readonly offset: number;
  readonly size: number;
}

export const audioChunkSpan = (index: Mp4AudioIndex, chunk: number): AudioChunkSpan => {
  const first = Math.max(0, chunk * AUDIO_CHUNK_FRAMES - PREROLL_FRAMES);
  const end = Math.min(index.frames, (chunk + 1) * AUDIO_CHUNK_FRAMES + POSTROLL_FRAMES);
  const offset = index.offsets[first] ?? 0;
  const last = Math.max(first, end - 1);
  return {
    first,
    end,
    offset,
    size: (index.offsets[last] ?? offset) + (index.sizes[last] ?? 0) - offset,
  };
};

/** Chunks `first` to `last`, read with one request for `size` bytes at `offset`. */
export interface AudioRange {
  readonly first: number;
  readonly last: number;
  readonly offset: number;
  readonly size: number;
}

/**
 * Groups the chunks `from` to `to` that `missing` says are needed into byte ranges of at most
 * `maxBytes`, so the seconds ahead of the playhead arrive in one request, not one per chunk.
 */
export function planAudioRanges(
  index: Mp4AudioIndex,
  from: number,
  to: number,
  missing: (chunk: number) => boolean,
  maxBytes: number,
): Array<AudioRange> {
  const ranges: Array<{ -readonly [K in keyof AudioRange]: AudioRange[K] }> = [];
  const last = Math.min(to, audioChunkCount(index) - 1);
  for (let chunk = Math.max(0, from); chunk <= last; chunk++) {
    if (!missing(chunk)) continue;
    const span = audioChunkSpan(index, chunk);
    const open = ranges.at(-1);
    const end = span.offset + span.size;
    if (
      open !== undefined &&
      open.last === chunk - 1 &&
      span.offset >= open.offset &&
      end - open.offset <= maxBytes
    ) {
      open.last = chunk;
      open.size = Math.max(open.size, end - open.offset);
    } else {
      ranges.push({ first: chunk, last: chunk, offset: span.offset, size: span.size });
    }
  }
  return ranges;
}

/**
 * The frames of a span as an ADTS stream, which `decodeAudioData` reads where WebCodecs has no
 * audio decoder. `bytes` holds the file from `base` on.
 */
export function adtsStream(
  index: Mp4AudioIndex,
  span: AudioChunkSpan,
  bytes: Uint8Array,
  base: number,
): Uint8Array {
  let total = 0;
  for (let frame = span.first; frame < span.end; frame++) total += 7 + index.sizes[frame]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (let frame = span.first; frame < span.end; frame++) {
    const size = index.sizes[frame]!;
    const length = size + 7;
    out[at] = 0xff;
    out[at + 1] = 0xf1;
    out[at + 2] =
      ((index.objectType - 1) << 6) | (index.frequencyIndex << 2) | (index.channelConfig >> 2);
    out[at + 3] = ((index.channelConfig & 3) << 6) | (length >> 11);
    out[at + 4] = (length >> 3) & 0xff;
    out[at + 5] = ((length & 7) << 5) | 0x1f;
    out[at + 6] = 0xfc;
    const from = index.offsets[frame]! - base;
    out.set(bytes.subarray(from, from + size), at + 7);
    at += length;
  }
  return out;
}
