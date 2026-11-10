/**
 * The sample table of an MP4's first video track, read straight from its boxes, so WebCodecs can
 * decode any frame without a media element. Written for Stellar's proxies (one H.264 track,
 * `+faststart`) but follows the ISO BMFF tables generally: stts, ctts, stss, stsz, stsc, stco/co64
 * and the edit list's start offset.
 */

export interface Mp4Sample {
  /** Presentation time in seconds, after the edit list. */
  readonly time: number;
  readonly duration: number;
  readonly key: boolean;
  readonly offset: number;
  readonly size: number;
}

export interface Mp4VideoIndex {
  readonly codec: string;
  readonly description: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** In decode order, as a decoder must be fed. */
  readonly samples: ReadonlyArray<Mp4Sample>;
}

interface Box {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  /** Where the payload begins, after the size and type (and a 64-bit size). */
  readonly body: number;
}

function readBoxes(view: DataView, start: number, end: number): Array<Box> {
  const boxes: Array<Box> = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(
      view.getUint8(at + 4),
      view.getUint8(at + 5),
      view.getUint8(at + 6),
      view.getUint8(at + 7),
    );
    let body = at + 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < 8 || at + size > end) break;
    boxes.push({ type, start: at, end: at + size, body });
    at += size;
  }
  return boxes;
}

const child = (view: DataView, box: Box | undefined, type: string): Box | undefined =>
  box === undefined
    ? undefined
    : readBoxes(view, box.body, box.end).find((candidate) => candidate.type === type);

const hex = (value: number) => value.toString(16).padStart(2, "0");

/** Parses the first video track of an MP4 whose bytes are all in `buffer`. */
export function indexMp4Video(buffer: ArrayBuffer): Mp4VideoIndex | null {
  const view = new DataView(buffer);
  const moov = readBoxes(view, 0, buffer.byteLength).find((box) => box.type === "moov");
  if (moov === undefined) return null;
  const traks = readBoxes(view, moov.body, moov.end).filter((box) => box.type === "trak");
  for (const trak of traks) {
    const mdia = child(view, trak, "mdia");
    const hdlr = child(view, mdia, "hdlr");
    if (hdlr === undefined) continue;
    const handler = String.fromCharCode(...new Uint8Array(buffer, hdlr.body + 8, 4));
    if (handler !== "vide") continue;

    const mdhd = child(view, mdia, "mdhd");
    if (mdhd === undefined) return null;
    const mdhdVersion = view.getUint8(mdhd.body);
    const timescale = view.getUint32(mdhd.body + (mdhdVersion === 1 ? 20 : 12));

    // The edit list's media time: frames before it (B-frame delay) are not presented.
    let editStart = 0;
    const elst = child(view, child(view, trak, "edts"), "elst");
    if (elst !== undefined && view.getUint32(elst.body + 4) > 0) {
      const version = view.getUint8(elst.body);
      editStart =
        version === 1
          ? Number(view.getBigInt64(elst.body + 8 + 8))
          : view.getInt32(elst.body + 8 + 4);
      if (editStart < 0) editStart = 0;
    }

    const stbl = child(view, child(view, mdia, "minf"), "stbl");
    const stsd = child(view, stbl, "stsd");
    if (stbl === undefined || stsd === undefined) return null;
    // stsd: version/flags, entry count, then the first sample entry (a VisualSampleEntry).
    const entryStart = stsd.body + 8;
    const entry = readBoxes(view, entryStart, stsd.end)[0];
    if (entry === undefined) return null;
    const width = view.getUint16(entry.body + 24);
    const height = view.getUint16(entry.body + 26);
    const config = readBoxes(view, entry.body + 78, entry.end).find(
      (box) => box.type === "avcC" || box.type === "hvcC",
    );
    if (config === undefined || config.type !== "avcC") return null;
    const description = new Uint8Array(buffer.slice(config.body, config.end));
    const codec = `avc1.${hex(description[1] ?? 0)}${hex(description[2] ?? 0)}${hex(description[3] ?? 0)}`;

    const table = (type: string) => child(view, stbl, type);
    const stts = table("stts");
    const stsz = table("stsz");
    const stsc = table("stsc");
    const chunkOffsets = table("stco") ?? table("co64");
    if (!stts || !stsz || !stsc || !chunkOffsets) return null;

    const count = view.getUint32(stsz.body + 8);
    const fixedSize = view.getUint32(stsz.body + 4);
    const sizes = Array.from({ length: count }, (_, i) =>
      fixedSize !== 0 ? fixedSize : view.getUint32(stsz.body + 12 + i * 4),
    );

    const decodeTimes: Array<number> = [];
    const durations: Array<number> = [];
    let dts = 0;
    for (let i = 0, entries = view.getUint32(stts.body + 4); i < entries; i++) {
      const runs = view.getUint32(stts.body + 8 + i * 8);
      const delta = view.getUint32(stts.body + 12 + i * 8);
      for (let j = 0; j < runs; j++) {
        decodeTimes.push(dts);
        durations.push(delta);
        dts += delta;
      }
    }

    const compositionOffsets = new Array<number>(count).fill(0);
    const ctts = table("ctts");
    if (ctts !== undefined) {
      const signed = view.getUint8(ctts.body) === 1;
      let sample = 0;
      for (let i = 0, entries = view.getUint32(ctts.body + 4); i < entries; i++) {
        const runs = view.getUint32(ctts.body + 8 + i * 8);
        const offset = signed
          ? view.getInt32(ctts.body + 12 + i * 8)
          : view.getUint32(ctts.body + 12 + i * 8);
        for (let j = 0; j < runs && sample < count; j++) compositionOffsets[sample++] = offset;
      }
    }

    const stss = table("stss");
    const keys = new Set<number>();
    if (stss !== undefined) {
      for (let i = 0, entries = view.getUint32(stss.body + 4); i < entries; i++) {
        keys.add(view.getUint32(stss.body + 8 + i * 4) - 1);
      }
    }

    const wide = chunkOffsets.type === "co64";
    const chunkCount = view.getUint32(chunkOffsets.body + 4);
    const chunkOffset = (chunk: number) =>
      wide
        ? Number(view.getBigUint64(chunkOffsets.body + 8 + chunk * 8))
        : view.getUint32(chunkOffsets.body + 8 + chunk * 4);
    const stscEntries = view.getUint32(stsc.body + 4);
    const offsets = new Array<number>(count);
    let sample = 0;
    for (let i = 0; i < stscEntries; i++) {
      const firstChunk = view.getUint32(stsc.body + 8 + i * 12) - 1;
      const perChunk = view.getUint32(stsc.body + 12 + i * 12);
      const lastChunk =
        i + 1 < stscEntries ? view.getUint32(stsc.body + 8 + (i + 1) * 12) - 1 : chunkCount;
      for (let chunk = firstChunk; chunk < lastChunk && sample < count; chunk++) {
        let at = chunkOffset(chunk);
        for (let j = 0; j < perChunk && sample < count; j++) {
          offsets[sample] = at;
          at += sizes[sample] ?? 0;
          sample++;
        }
      }
    }

    const samples: Array<Mp4Sample> = sizes.map((size, i) => ({
      time: ((decodeTimes[i] ?? 0) + (compositionOffsets[i] ?? 0) - editStart) / timescale,
      duration: (durations[i] ?? 0) / timescale,
      key: stss === undefined || keys.has(i),
      offset: offsets[i] ?? 0,
      size,
    }));
    return { codec, description, width, height, samples };
  }
  return null;
}
