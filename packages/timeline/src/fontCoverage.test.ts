import { describe, expect, it } from "vite-plus/test";

import {
  faceIsNamed,
  fileNameMatch,
  fontFaces,
  isVietnamese,
  missingGlyphs,
  VIETNAMESE_LETTERS,
} from "./fontCoverage.ts";

const u16 = (value: number) => [(value >> 8) & 255, value & 255];
const u32 = (value: number) => [...u16(Math.floor(value / 65536)), ...u16(value & 0xffff)];

const nameTable = (names: ReadonlyArray<readonly [number, string]>) => {
  const strings = names.map(([, text]) => [...text].flatMap((letter) => u16(letter.charCodeAt(0))));
  let offset = 0;
  const records = names.flatMap(([id], index) => {
    const record = [
      ...u16(3),
      ...u16(1),
      ...u16(0x409),
      ...u16(id),
      ...u16(strings[index]!.length),
      ...u16(offset),
    ];
    offset += strings[index]!.length;
    return record;
  });
  return [
    ...u16(0),
    ...u16(names.length),
    ...u16(6 + names.length * 12),
    ...records,
    ...strings.flat(),
  ];
};

/** A cmap with one format 12 subtable mapping each `[start, end]` range to glyphs from 1. */
const cmap12 = (ranges: ReadonlyArray<readonly [number, number]>) => {
  let glyph = 1;
  const groups = ranges.flatMap(([start, end]) => {
    const group = [...u32(start), ...u32(end), ...u32(glyph)];
    glyph += end - start + 1;
    return group;
  });
  const subtable = [
    ...u16(12),
    ...u16(0),
    ...u32(16 + groups.length),
    ...u32(0),
    ...u32(ranges.length),
    ...groups,
  ];
  return [...u16(0), ...u16(1), ...u16(3), ...u16(10), ...u32(12), ...subtable];
};

/** A cmap with one format 4 subtable, each range mapped by a delta to glyphs from 1. */
const cmap4 = (ranges: ReadonlyArray<readonly [number, number]>) => {
  const segments = [...ranges, [0xffff, 0xffff] as const];
  let glyph = 1;
  const deltas = segments.map(([start, end], index) => {
    if (index === segments.length - 1) return 1;
    const delta = (glyph - start + 65536) & 0xffff;
    glyph += end - start + 1;
    return delta;
  });
  const count = segments.length;
  const body = [
    ...segments.flatMap(([, end]) => u16(end)),
    ...u16(0),
    ...segments.flatMap(([start]) => u16(start)),
    ...deltas.flatMap(u16),
    ...segments.flatMap(() => u16(0)),
  ];
  const subtable = [
    ...u16(4),
    ...u16(14 + body.length),
    ...u16(0),
    ...u16(count * 2),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...body,
  ];
  return [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...subtable];
};

/** An sfnt of `tables`, placed `base` bytes into its file. */
const sfnt = (tables: Readonly<Record<string, ReadonlyArray<number>>>, base = 0) => {
  const tags = Object.keys(tables);
  let offset = base + 12 + tags.length * 16;
  const records: Array<number> = [];
  const data: Array<number> = [];
  for (const name of tags) {
    const table = [...tables[name]!];
    while (table.length % 4 !== 0) table.push(0);
    records.push(
      ...[...name].map((letter) => letter.charCodeAt(0)),
      ...u32(0),
      ...u32(offset),
      ...u32(table.length),
    );
    data.push(...table);
    offset += table.length;
  }
  return [
    ...u32(0x00010000),
    ...u16(tags.length),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...records,
    ...data,
  ];
};

const LATIN = [0x20, 0x7e] as const;
const names = [
  [1, "Test Sans"],
  [4, "Test Sans SemiBold"],
  [6, "TestSans-SemiBold"],
] as const;

describe("fontFaces", () => {
  it.each([
    ["format 12", cmap12],
    ["format 4", cmap4],
  ])("reads names and which letters a %s cmap maps", (_, cmap) => {
    // ASCII, đ and ơ, but not ó, ả or ữ.
    const bytes = new Uint8Array(
      sfnt({ name: nameTable(names), cmap: cmap([LATIN, [0x0111, 0x0111], [0x01a1, 0x01a1]]) }),
    );
    const [face] = fontFaces(bytes);
    expect(face?.names).toEqual(["Test Sans", "Test Sans SemiBold", "TestSans-SemiBold"]);
    expect(faceIsNamed(face!, "testsans semibold")).toBe(true);
    expect(missingGlyphs(face!, "Đơn giản\nlắm đó ữ")).toEqual(["Đ", "ả", "ắ", "ó", "ữ"]);
  });

  it("reads each face of a collection", () => {
    const face = sfnt({ name: nameTable(names), cmap: cmap12([LATIN]) }, 16);
    const bytes = new Uint8Array(
      [..."ttcf"].map((l) => l.charCodeAt(0)).concat(u32(0x00010000), u32(1), u32(16), face),
    );
    expect(fontFaces(bytes).map((found) => found.names[2])).toEqual(["TestSans-SemiBold"]);
    expect(fontFaces(new Uint8Array([1, 2, 3]))).toEqual([]);
  });
});

describe("Vietnamese letters", () => {
  it("lists every vowel with every tone, and đ, in both cases", () => {
    expect(VIETNAMESE_LETTERS).toHaveLength(146);
    expect(VIETNAMESE_LETTERS).toEqual(expect.arrayContaining(["ệ", "ữ", "ẫ", "Ơ", "Ư", "Đ"]));
  });

  it("tells Vietnamese from English with a borrowed accent", () => {
    expect(isVietnamese("Ghiền Mì Gõ")).toBe(true);
    expect(isVietnamese("a café résumé")).toBe(false);
  });
});

describe("fileNameMatch", () => {
  it("ranks the font file a PostScript name is most likely in", () => {
    expect(fileNameMatch("BeVietnamPro-SemiBold.ttf", "BeVietnamPro-SemiBold")).toBe(3);
    expect(fileNameMatch("BeVietnamPro.ttc", "BeVietnamPro-SemiBold")).toBe(2);
    expect(fileNameMatch("Helvetica.ttc", "BeVietnamPro-SemiBold")).toBe(0);
  });
});
