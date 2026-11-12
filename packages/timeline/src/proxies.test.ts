import { describe, expect, it } from "vite-plus/test";

import {
  MAX_STRIP_TILES,
  orientationFilters,
  peaksFromPcm,
  pngOrientation,
  proxyIdentity,
  rateChangesFrom,
  stillConverters,
  stillFormat,
  stripSpacing,
} from "./proxies.ts";

const pcm = (samples: ReadonlyArray<number>) => {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return bytes;
};

describe("proxies", () => {
  it("reads peaks as the loudest sample per window, either polarity, on a 0–100 scale", () => {
    expect(peaksFromPcm(pcm([0, 16384, -32768, 100, 3277]), 2)).toEqual([50, 100, 10]);
  });

  it("finds where a clip's frame rate changes, and nothing in a steady clip", () => {
    const frames = (from: number, to: number, fps: number) =>
      Array.from({ length: Math.round((to - from) * fps) }, (_, i) => from + i / fps);
    // 60 fps with the odd dropped frame is still one rate.
    expect(rateChangesFrom(frames(0, 5, 60).filter((_, i) => i % 50 !== 7))).toEqual([]);
    expect(
      rateChangesFrom([...frames(0, 6, 60), ...frames(6, 9, 30), ...frames(9, 12, 60)]),
    ).toEqual([
      { at: 0, fps: 60 },
      { at: 6, fps: 30 },
      { at: 9, fps: 60 },
    ]);
  });

  it("spaces strip tiles a second apart until the tile cap, then stretches them", () => {
    expect(stripSpacing(12.5)).toEqual({ every: 1, count: 13 });
    const long = stripSpacing(3600);
    expect(long.count).toBe(MAX_STRIP_TILES);
    expect(long.every).toBe(12);
  });
});

describe("still renditions", () => {
  it("picks the tools that can read each still format, or says why none can", () => {
    const mac = { sips: true, heif: null } as const;
    const linux = { sips: false, heif: "heif-convert" } as const;
    const bare = { sips: false, heif: null } as const;
    expect(
      ["a.PSD", "b.tif", "c.HEIC", "d.heif", "e.dng", "f.png", "g.jpg"].map(stillFormat),
    ).toEqual(["psd", "tiff", "heic", "heic", "raw", null, null]);
    // ffmpeg reads one tile of a HEIC, so it is never offered one.
    expect(stillConverters("heic", mac)).toEqual({ converters: ["sips"] });
    expect(stillConverters("heic", linux)).toEqual({ converters: ["heif-convert"] });
    expect(stillConverters("heic", bare)).toMatchObject({ converters: [], reason: /heif-dec/ });
    expect(stillConverters("psd", mac)).toEqual({ converters: ["sips", "ffmpeg"] });
    expect(stillConverters("tiff", bare)).toEqual({ converters: ["ffmpeg"] });
    expect(stillConverters("raw", linux)).toMatchObject({ converters: [], reason: /macOS/ });
  });

  it("reads the orientation sips leaves in a PNG's eXIf chunk", () => {
    const chunk = (type: string, body: ReadonlyArray<number>) => [
      0,
      0,
      0,
      body.length,
      ...[...type].map((c) => c.charCodeAt(0)),
      ...body,
      0,
      0,
      0,
      0,
    ];
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    // Big-endian TIFF header, one IFD entry: tag 0x0112 (orientation), SHORT, count 1, value 6.
    const exif = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 1, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0];
    const png = (...chunks: Array<Array<number>>) =>
      Uint8Array.from([...signature, ...chunks.flat()]);
    const header = chunk("IHDR", new Array(13).fill(0));
    expect(pngOrientation(png(header, chunk("eXIf", exif), chunk("IDAT", [1])))).toBe(6);
    expect(pngOrientation(png(header, chunk("IDAT", [1]), chunk("eXIf", exif)))).toBe(1);
    expect(pngOrientation(png(header, chunk("eXIf", exif.slice(0, 12))))).toBe(1);
    expect(orientationFilters(6)).toEqual(["transpose=1"]);
    expect(orientationFilters(1)).toEqual([]);
  });
});

describe("proxyIdentity", () => {
  it("names a file by its place under the media root, wherever the root is mounted", () => {
    const mac = proxyIdentity("/Volumes/SSD/Short/Footage/a.mov", ["/Volumes/SSD/Short"]);
    expect(mac).toBe("Footage/a.mov");
    expect(proxyIdentity("E:\\Short\\Footage\\a.mov", ["E:\\Short\\"])).toBe(mac);
    expect(proxyIdentity("Footage/a.mov", ["/anything"])).toBe(mac);
    // Outside every root there is nothing shorter to go by.
    expect(proxyIdentity("/Users/me/Music/song.wav", ["/Volumes/SSD/Short"])).toBe(
      "/Users/me/Music/song.wav",
    );
    expect(proxyIdentity("/Volumes/SSD/Shorter/a.mov", ["/Volumes/SSD/Short"])).toBe(
      "/Volumes/SSD/Shorter/a.mov",
    );
  });
});
