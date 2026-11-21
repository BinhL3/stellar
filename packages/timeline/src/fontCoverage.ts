/**
 * Which characters a font file can draw, read from its `cmap`, and the names it answers to,
 * from its `name` table. A missing glyph draws as an empty box or another font's letter, and
 * nothing fails, so captions are checked against the font before they are made.
 */

export interface FontFace {
  /** Family, full and PostScript names, such as "Be Vietnam Pro" and "BeVietnamPro-SemiBold". */
  readonly names: ReadonlyArray<string>;
  readonly has: (codePoint: number) => boolean;
}

const tag = (view: DataView, at: number) =>
  String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );

const tablesOf = (view: DataView, at: number) => {
  const tables = new Map<string, number>();
  const count = view.getUint16(at + 4);
  for (let index = 0; index < count; index++) {
    const record = at + 12 + index * 16;
    tables.set(tag(view, record), view.getUint32(record + 8));
  }
  return tables;
};

// Family (1), full (4), PostScript (6) and typographic family (16) names.
const NAME_IDS = new Set([1, 4, 6, 16]);

const namesOf = (view: DataView, at: number): Array<string> => {
  const count = view.getUint16(at + 2);
  const strings = at + view.getUint16(at + 4);
  const names = new Set<string>();
  for (let index = 0; index < count; index++) {
    const record = at + 6 + index * 12;
    const platform = view.getUint16(record);
    const id = view.getUint16(record + 6);
    if (!NAME_IDS.has(id)) continue;
    const length = view.getUint16(record + 8);
    const start = strings + view.getUint16(record + 10);
    let text = "";
    if (platform === 0 || platform === 3) {
      for (let i = 0; i + 1 < length; i += 2)
        text += String.fromCharCode(view.getUint16(start + i));
    } else if (platform === 1) {
      for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(start + i));
    } else continue;
    if (text.trim() !== "") names.add(text.trim());
  }
  return [...names];
};

/** A lookup of the code points one `cmap` subtable maps to a glyph other than .notdef. */
const subtableLookup = (view: DataView, at: number): ((codePoint: number) => boolean) | null => {
  const format = view.getUint16(at);
  if (format === 12) {
    const groups = view.getUint32(at + 12);
    return (codePoint) => {
      for (let index = 0; index < groups; index++) {
        const group = at + 16 + index * 12;
        const start = view.getUint32(group);
        const end = view.getUint32(group + 4);
        if (codePoint >= start && codePoint <= end) {
          return view.getUint32(group + 8) + codePoint - start !== 0;
        }
      }
      return false;
    };
  }
  if (format === 4) {
    const segments = view.getUint16(at + 6) / 2;
    const ends = at + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const offsets = deltas + segments * 2;
    return (codePoint) => {
      if (codePoint > 0xffff) return false;
      for (let index = 0; index < segments; index++) {
        if (view.getUint16(ends + index * 2) < codePoint) continue;
        const start = view.getUint16(starts + index * 2);
        if (start > codePoint) return false;
        const delta = view.getUint16(deltas + index * 2);
        const offsetAt = offsets + index * 2;
        const offset = view.getUint16(offsetAt);
        if (offset === 0) return ((codePoint + delta) & 0xffff) !== 0;
        const glyph = view.getUint16(offsetAt + offset + (codePoint - start) * 2);
        return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
      }
      return false;
    };
  }
  return null;
};

const cmapOf = (view: DataView, at: number): ((codePoint: number) => boolean) => {
  const count = view.getUint16(at + 2);
  const subtables: Array<{ rank: number; offset: number }> = [];
  for (let index = 0; index < count; index++) {
    const record = at + 4 + index * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    // Full Unicode first, then the Basic Multilingual Plane.
    const rank =
      (platform === 3 && encoding === 10) || (platform === 0 && encoding >= 4)
        ? 0
        : (platform === 3 && encoding === 1) || platform === 0
          ? 1
          : null;
    if (rank !== null) subtables.push({ rank, offset: at + view.getUint32(record + 4) });
  }
  for (const subtable of subtables.toSorted((a, b) => a.rank - b.rank)) {
    const lookup = subtableLookup(view, subtable.offset);
    if (lookup !== null) return lookup;
  }
  return () => false;
};

/** The faces in a TrueType, OpenType or collection file; empty for anything else. */
export const fontFaces = (bytes: Uint8Array): Array<FontFace> => {
  if (bytes.length < 12) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const starts =
    tag(view, 0) === "ttcf"
      ? Array.from({ length: view.getUint32(8) }, (_, index) => view.getUint32(12 + index * 4))
      : [0];
  const faces: Array<FontFace> = [];
  for (const start of starts) {
    try {
      const tables = tablesOf(view, start);
      const name = tables.get("name");
      const cmap = tables.get("cmap");
      if (name === undefined || cmap === undefined) continue;
      faces.push({ names: namesOf(view, name), has: cmapOf(view, cmap) });
    } catch {
      // A damaged face reads past the file's end; the file's other faces still count.
    }
  }
  return faces;
};

const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Whether a face answers to `name`, ignoring case, spaces and hyphens. */
export const faceIsNamed = (face: FontFace, name: string): boolean =>
  face.names.some((candidate) => nameKey(candidate) === nameKey(name));

/** How likely a font file is to hold `name`, from its file name alone: higher reads first. */
export const fileNameMatch = (fileName: string, name: string): number => {
  const file = nameKey(fileName.replace(/\.[^.]+$/, ""));
  const wanted = nameKey(name);
  if (file === wanted) return 3;
  if (file.startsWith(wanted) || wanted.startsWith(file)) return 2;
  const family = nameKey(name.split(/[-\s]/)[0] ?? name);
  return family.length >= 3 && file.includes(family) ? 1 : 0;
};

/** Every Vietnamese letter: each vowel with each tone, and đ, in both cases. */
export const VIETNAMESE_LETTERS: ReadonlyArray<string> = (() => {
  const vowels = ["a", "ă", "â", "e", "ê", "i", "o", "ô", "ơ", "u", "ư", "y"];
  const tones = ["", "̀", "́", "̉", "̃", "̣"];
  const lower = [
    ...vowels.flatMap((vowel) => tones.map((tone) => (vowel + tone).normalize("NFC"))),
    "đ",
  ];
  return [...lower, ...lower.map((letter) => letter.toUpperCase())];
})();

const VIETNAMESE_ONLY = new Set(
  VIETNAMESE_LETTERS.filter((letter) => !/^[a-zA-ZàáâãèéêìíòóôõùúýÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝ]$/.test(letter)),
);

/** Whether `text` uses a letter only Vietnamese writes. */
export const isVietnamese = (text: string): boolean =>
  [...text.normalize("NFC")].some((letter) => VIETNAMESE_ONLY.has(letter));

/**
 * The characters of `text` the face can't draw, each once, in order. Spaces and line breaks
 * need no glyph. Vietnamese is checked in its composed form, the letters as typed.
 */
export const missingGlyphs = (face: FontFace, text: string): Array<string> => {
  const missing = new Set<string>();
  for (const letter of text.normalize("NFC")) {
    if (/\s/.test(letter)) continue;
    if (!face.has(letter.codePointAt(0) ?? 0)) missing.add(letter);
  }
  return [...missing];
};
