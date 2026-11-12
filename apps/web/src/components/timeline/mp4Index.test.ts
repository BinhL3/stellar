import { describe, expect, it } from "vite-plus/test";

import {
  indexMp4Video,
  keyframeBefore,
  keyframesOf,
  locateMoov,
  type Mp4Sample,
  planRanges,
  planSegments,
  segmentOf,
} from "./mp4Index";

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const box = (type: string, ...parts: Array<Array<number>>) => {
  const body = parts.flat();
  return [...u32(body.length + 8), ...[...type].map((c) => c.charCodeAt(0)), ...body];
};
const full = (version: number) => [version, 0, 0, 0];

/**
 * A two-GOP, B-frame-ordered H.264 track at 30 fps, as ffmpeg writes proxies: decode order
 * I P B | I P B, one chunk per sample, a 2-frame edit list offset and composition offsets.
 */
function sampleMp4() {
  const sizes = [10, 20, 30, 40, 50, 60];
  const avcC = box("avcC", [1, 0x64, 0x00, 0x1f, 0xff, 0xe0, 0, 0]);
  const avc1 = box(
    "avc1",
    [0, 0, 0, 0, 0, 0, ...u16(1)],
    new Array(16).fill(0),
    [...u16(540), ...u16(960)],
    new Array(50).fill(0),
    avcC,
  );
  const stsd = box("stsd", full(0), u32(1), avc1);
  const stts = box("stts", full(0), u32(1), u32(6), u32(1000));
  // Presentation offsets (in 1/30000 s): I +2000, P +3000, B +1000 per GOP.
  const ctts = box(
    "ctts",
    full(0),
    u32(6),
    ...[2000, 3000, 1000, 2000, 3000, 1000].map((o) => [...u32(1), ...u32(o)]),
  );
  const stss = box("stss", full(0), u32(2), u32(1), u32(4));
  const stsz = box("stsz", full(0), u32(0), u32(6), ...sizes.map(u32));
  const stsc = box("stsc", full(0), u32(1), u32(1), u32(1), u32(1));
  // Chunk offsets point into the mdat that follows; filled in below.
  const offsets = sizes.map((_, i) => 1000 + sizes.slice(0, i).reduce((a, b) => a + b, 0));
  const stco = box("stco", full(0), u32(6), ...offsets.map(u32));
  const stbl = box("stbl", stsd, stts, ctts, stss, stsz, stsc, stco);
  const mdhd = box("mdhd", full(0), u32(0), u32(0), u32(30000), u32(6000), [0, 0, 0, 0]);
  const hdlr = box(
    "hdlr",
    full(0),
    u32(0),
    [..."vide"].map((c) => c.charCodeAt(0)),
    new Array(12).fill(0),
    [0],
  );
  const elst = box("elst", full(0), u32(1), u32(6000), u32(2000), [0, 1, 0, 0]);
  const trak = box("trak", box("edts", elst), box("mdia", mdhd, hdlr, box("minf", stbl)));
  return new Uint8Array(box("moov", trak)).buffer;
}

describe("indexMp4Video", () => {
  it("reads codec, size and every sample's time, key flag, offset and size", () => {
    const index = indexMp4Video(sampleMp4());
    expect(index).toMatchObject({ codec: "avc1.64001f", width: 540, height: 960 });
    expect(index?.samples.map((s) => [+s.time.toFixed(4), s.key, s.offset, s.size])).toEqual([
      // Decode order; times are presentation times minus the 2000-tick edit-list offset.
      [0, true, 1000, 10],
      [0.0667, false, 1010, 20],
      [0.0333, false, 1030, 30],
      [0.1, true, 1060, 40],
      [0.1667, false, 1100, 50],
      [0.1333, false, 1150, 60],
    ]);
  });

  it("rejects files without a video track", () => {
    expect(indexMp4Video(new Uint8Array(box("free", [0, 0, 0, 0])).buffer)).toBeNull();
  });
});

describe("locateMoov", () => {
  const ftyp = box("ftyp", new Array(16).fill(0));
  const moov = [...new Uint8Array(sampleMp4())];
  const bytes = (...parts: Array<Array<number>>) => new Uint8Array(parts.flat()).buffer;

  it("finds the index at the front of a faststart file, even when the head cuts it short", () => {
    const whole = bytes(ftyp, moov, box("mdat", new Array(64).fill(0)));
    expect(locateMoov(whole)).toEqual({ start: 24, end: 24 + moov.length });
    expect(locateMoov(whole.slice(0, 40))).toEqual({ start: 24, end: 24 + moov.length });
  });

  it("points past the media when the index comes last", () => {
    // Only the head of a large mdat is in hand; its size says where the next box starts.
    const head = bytes(ftyp, [...u32(5000), ...[..."mdat"].map((c) => c.charCodeAt(0))], [1, 2]);
    expect(locateMoov(head)).toEqual({ start: 24 + 5000, end: Number.POSITIVE_INFINITY });
    expect(locateMoov(bytes([0, 0, 0, 3, 1, 2, 3, 4]))).toBeNull();
  });
});

describe("range planning", () => {
  // Ten GOPs of three 100-byte samples at 30 fps, back to back from byte 1000.
  const samples: Array<Mp4Sample> = Array.from({ length: 30 }, (_, i) => ({
    time: i / 30,
    duration: 1 / 30,
    key: i % 3 === 0,
    offset: 1000 + i * 100,
    size: 100,
  }));

  it("cuts segments at keyframes once they reach the target size", () => {
    const segments = planSegments(samples, 500);
    expect(segments.map((s) => [s.first, s.end, s.offset, s.size])).toEqual([
      [0, 6, 1000, 600],
      [6, 12, 1600, 600],
      [12, 18, 2200, 600],
      [18, 24, 2800, 600],
      [24, 30, 3400, 600],
    ]);
    expect([0, 5, 6, 29].map((sample) => segmentOf(segments, sample))).toEqual([0, 0, 1, 4]);
    // A small file is one segment: the whole thing.
    expect(planSegments(samples, Number.POSITIVE_INFINITY)).toEqual([
      { first: 0, end: 30, offset: 1000, size: 3000 },
    ]);
    expect(planSegments([], 500)).toEqual([]);
  });

  it("finds the keyframe to decode from for any time", () => {
    const keys = keyframesOf(samples);
    expect([0, 0.09, 0.1, 0.5, 99].map((time) => keyframeBefore(samples, keys, time))).toEqual([
      0, 0, 3, 15, 27,
    ]);
    // In a real track decode order runs ahead of presentation order inside a GOP.
    const reordered = indexMp4Video(sampleMp4())!.samples;
    expect(
      [0, 0.0667, 0.1, 0.1667].map((time) =>
        keyframeBefore(reordered, keyframesOf(reordered), time),
      ),
    ).toEqual([0, 0, 3, 3]);
  });

  it("reads neighbouring missing segments in one request, within the size cap", () => {
    const segments = planSegments(samples, 500);
    const all = () => true;
    expect(planRanges(segments, 0, 4, all, 1200)).toEqual([
      { first: 0, last: 1, offset: 1000, size: 1200 },
      { first: 2, last: 3, offset: 2200, size: 1200 },
      { first: 4, last: 4, offset: 3400, size: 600 },
    ]);
    // What is already held splits the run; asking past either end is clamped.
    expect(planRanges(segments, -2, 9, (segment) => segment !== 1, 10_000)).toEqual([
      { first: 0, last: 0, offset: 1000, size: 600 },
      { first: 2, last: 4, offset: 2200, size: 1800 },
    ]);
    expect(planRanges(segments, 1, 3, () => false, 10_000)).toEqual([]);
    expect(planRanges(segments, 3, 2, all, 10_000)).toEqual([]);
  });
});
