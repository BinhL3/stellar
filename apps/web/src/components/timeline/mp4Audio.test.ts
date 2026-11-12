import { describe, expect, it } from "vite-plus/test";

import { ByteLru } from "./audioCache";
import {
  adtsStream,
  AUDIO_CHUNK_FRAMES,
  audioChunkCount,
  audioChunkSpan,
  indexMp4Audio,
  planAudioRanges,
} from "./mp4Audio";
import { createRangeBudget } from "./rangeBudget";

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
const box = (type: string, ...parts: Array<Array<number>>) => {
  const body = parts.flat();
  return [...u32(body.length + 8), ...text(type), ...body];
};
const full = (version: number) => [version, 0, 0, 0];

const FRAMES = 300;
const MEDIA_AT = 4096;
/** Frame `i` is `100 + (i % 7)` bytes, so offsets are easy to predict. */
const sizeOf = (frame: number) => 100 + (frame % 7);

/**
 * An AAC-LC stereo track at 48 kHz as ffmpeg writes an `.m4a`: every frame in one chunk, an
 * edit list that skips 1024 priming samples, and optionally an empty edit that delays it.
 */
function sampleM4a(options: { readonly delayMs?: number } = {}) {
  // AudioSpecificConfig: object type 2 (LC), frequency index 3 (48 kHz), 2 channels.
  const config = [0x11, 0x90];
  const esds = box(
    "esds",
    full(0),
    [0x03, 0x80, 0x80, 0x80, 26 + config.length, ...u16(1), 0],
    [0x04, 0x80, 0x80, 0x80, 18 + config.length, 0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0)],
    [0x05, 0x80, 0x80, 0x80, config.length, ...config],
  );
  const mp4a = box(
    "mp4a",
    [0, 0, 0, 0, 0, 0, ...u16(1)],
    [
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u16(2),
      ...u16(16),
      ...u16(0),
      ...u16(0),
      ...u32(48000 << 16),
    ],
    esds,
  );
  const stsd = box("stsd", full(0), u32(1), mp4a);
  const stts = box("stts", full(0), u32(1), u32(FRAMES), u32(1024));
  const stsz = box(
    "stsz",
    full(0),
    u32(0),
    u32(FRAMES),
    ...Array.from({ length: FRAMES }, (_, i) => u32(sizeOf(i))),
  );
  const stsc = box("stsc", full(0), u32(1), u32(1), u32(FRAMES), u32(1));
  const stco = box("stco", full(0), u32(1), u32(MEDIA_AT));
  const stbl = box("stbl", stsd, stts, stsz, stsc, stco);
  const mdhd = box("mdhd", full(0), u32(0), u32(0), u32(48000), u32(FRAMES * 1024), [0, 0, 0, 0]);
  const hdlr = box("hdlr", full(0), u32(0), text("soun"), new Array(12).fill(0), [0]);
  const mdia = box("mdia", mdhd, hdlr, box("minf", stbl));
  const edits = [
    ...(options.delayMs === undefined
      ? []
      : [[...u32(options.delayMs), ...u32(0xffffffff), ...u32(0x10000)]]),
    [...u32(6400), ...u32(1024), ...u32(0x10000)],
  ];
  const edts = box("edts", box("elst", full(0), u32(edits.length), ...edits));
  const mvhd = box("mvhd", full(0), u32(0), u32(0), u32(1000), u32(6400));
  const moov = box("moov", mvhd, box("trak", edts, mdia));
  return new Uint8Array(moov).buffer;
}

describe("indexMp4Audio", () => {
  it("reads the codec, the frames and where each one sits", () => {
    const index = indexMp4Audio(sampleM4a())!;
    expect(index).toMatchObject({
      codec: "mp4a.40.2",
      sampleRate: 48000,
      channels: 2,
      frameSamples: 1024,
      frames: FRAMES,
    });
    expect([...index.config]).toEqual([0x11, 0x90]);
    expect(index.offsets[0]).toBe(MEDIA_AT);
    expect(index.offsets[8]).toBe(MEDIA_AT + 100 + 101 + 102 + 103 + 104 + 105 + 106 + 100);
    expect(index.sizes[8]).toBe(101);
  });

  it("places the first decoded sample before zero by the priming, and after it by a delay", () => {
    expect(indexMp4Audio(sampleM4a())!.origin).toBeCloseTo(-1024 / 48000, 12);
    expect(indexMp4Audio(sampleM4a({ delayMs: 500 }))!.origin).toBeCloseTo(0.5 - 1024 / 48000, 12);
  });

  it("returns null for a file with no AAC track", () => {
    expect(
      indexMp4Audio(
        new Uint8Array(box("moov", box("mvhd", full(0), new Array(96).fill(0)))).buffer,
      ),
    ).toBeNull();
    expect(indexMp4Audio(new Uint8Array(64).buffer)).toBeNull();
  });
});

describe("audio chunks", () => {
  const index = indexMp4Audio(sampleM4a())!;

  it("decodes each chunk with frames before and after it, inside the file", () => {
    expect(audioChunkCount(index)).toBe(3);
    expect(audioChunkSpan(index, 0)).toMatchObject({ first: 0, end: AUDIO_CHUNK_FRAMES + 1 });
    const second = audioChunkSpan(index, 1);
    expect(second).toMatchObject({
      first: AUDIO_CHUNK_FRAMES - 2,
      end: 2 * AUDIO_CHUNK_FRAMES + 1,
    });
    expect(second.offset).toBe(index.offsets[AUDIO_CHUNK_FRAMES - 2]);
    expect(second.offset + second.size).toBe(
      index.offsets[2 * AUDIO_CHUNK_FRAMES]! + index.sizes[2 * AUDIO_CHUNK_FRAMES]!,
    );
    expect(audioChunkSpan(index, 2)).toMatchObject({ first: 254, end: FRAMES });
  });

  it("reads neighbouring chunks in one request, up to the size allowed, skipping what is held", () => {
    const all = planAudioRanges(index, 0, 2, () => true, 1024 * 1024);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ first: 0, last: 2, offset: MEDIA_AT });
    expect(all[0]!.size).toBe(index.offsets[FRAMES - 1]! + index.sizes[FRAMES - 1]! - MEDIA_AT);

    expect(
      planAudioRanges(index, 0, 2, () => true, 16 * 1024).map((r) => [r.first, r.last]),
    ).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(
      planAudioRanges(index, 0, 9, (chunk) => chunk !== 1, 1024 * 1024).map((r) => [
        r.first,
        r.last,
      ]),
    ).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });

  it("wraps frames as ADTS with each frame's length in its header", () => {
    const span = { first: 3, end: 5, offset: index.offsets[3]!, size: 0 };
    const bytes = new Uint8Array(1024).fill(7);
    const stream = adtsStream(index, span, bytes, index.offsets[3]!);
    expect(stream.byteLength).toBe(7 + sizeOf(3) + 7 + sizeOf(4));
    // Sync word, AAC-LC at frequency index 3, two channels.
    expect([stream[0], stream[1], stream[2]! >> 6, (stream[2]! >> 2) & 15]).toEqual([
      0xff, 0xf1, 1, 3,
    ]);
    expect(((stream[2]! & 1) << 2) | (stream[3]! >> 6)).toBe(2);
    const length = ((stream[3]! & 3) << 11) | (stream[4]! << 3) | (stream[5]! >> 5);
    expect(length).toBe(7 + sizeOf(3));
    expect(stream[length]).toBe(0xff);
  });
});

describe("ByteLru", () => {
  it("drops the least recently used entries once over budget, telling their owner", () => {
    const cache = new ByteLru<string>(100);
    const dropped: Array<string> = [];
    for (const key of ["a", "b", "c"]) cache.add(key, 40, () => dropped.push(key));
    expect(dropped).toEqual(["a"]);
    expect(cache.bytes).toBe(80);
    // Using an entry keeps it; the next one in line goes instead.
    cache.touch("b");
    cache.add("d", 40, () => dropped.push("d"));
    expect(dropped).toEqual(["a", "c"]);
    cache.delete("b");
    expect(cache.bytes).toBe(40);
  });

  it("keeps an entry larger than the whole budget, alone", () => {
    const cache = new ByteLru<string>(100);
    const dropped: Array<string> = [];
    cache.add("small", 10, () => dropped.push("small"));
    cache.add("huge", 500, () => dropped.push("huge"));
    expect(dropped).toEqual(["small"]);
    expect(cache.bytes).toBe(500);
  });
});

describe("range budget", () => {
  it("caps the total and each kind, so neither picture nor sound can take every connection", () => {
    const budget = createRangeBudget(5, { video: 4, audio: 2 });
    expect([1, 2, 3, 4, 5].map(() => budget.take("video"))).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    // Video is at its share; sound still gets the last connection, and only that one.
    expect(budget.take("audio")).toBe(true);
    expect(budget.take("audio")).toBe(false);
    expect(budget.inFlight()).toBe(5);
    budget.release("video");
    expect(budget.take("audio")).toBe(true);
    expect(budget.take("audio")).toBe(false);
  });

  it("tells waiters once when a slot frees up", () => {
    const budget = createRangeBudget(1, { video: 1, audio: 1 });
    budget.take("video");
    let told = 0;
    const waiter = () => {
      told += 1;
    };
    budget.whenFree(waiter);
    budget.whenFree(waiter);
    budget.release("video");
    budget.release("video");
    expect(told).toBe(1);
  });
});
