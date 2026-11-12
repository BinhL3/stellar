// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous decoding of an in-memory blob.
/**
 * Reads the words and look of a Premiere text layer or caption: a base64 FlatBuffer with no
 * published schema (field numbers below, worked out from real projects), or on some
 * plugin-made titles UTF-16 JSON with named fields (`mTextParam`).
 */
import * as NodeBuffer from "node:buffer";

export interface TextRun {
  readonly text: string;
  /** PostScript name, such as "BeVietnamPro-SemiBold". */
  readonly font?: string;
  /** Pixels of the sequence frame, before the text layer's and the clip's scale. */
  readonly size?: number;
  /** "#rrggbb", or "none" for text that is only its stroke. Unset draws white. */
  readonly fill?: string;
  readonly stroke?: { readonly color: string; readonly width: number };
}

export interface TextStyle {
  readonly align: "left" | "center" | "right";
  readonly runs: ReadonlyArray<TextRun>;
  readonly shadow?: {
    readonly color: string;
    /** 0 to 1. */
    readonly opacity: number;
    /** Degrees, Premiere's: 135 throws the shadow down and to the right. */
    readonly angle: number;
    readonly distance: number;
    readonly blur: number;
  };
  /** A box behind the lines; `padding` is in the same pixels as a run's size. */
  readonly background?: {
    readonly color: string;
    readonly opacity: number;
    readonly padding: number;
  };
  /** The text layer's own Scale, in percent, on top of the clip's Motion. */
  readonly scale?: number;
}

// Field numbers of the FlatBuffer's tables. A colour is red, green and blue bytes that each
// default to 255. The background box has no entry: no project seen has one to learn it from.
const DOCUMENT = {
  runs: 0,
  fonts: 1,
  justification: 4,
  shadowColour: 10,
  shadowOn: 11,
  shadowOpacity: 12,
  shadowAngle: 13,
  shadowDistance: 14,
  shadowBlur: 16,
} as const;
const RUN = { text: 0, style: 1 } as const;
const STYLE = {
  font: 0,
  size: 1,
  fill: 2,
  strokeColour: 4,
  strokeOn: 5,
  strokeWidth: 6,
} as const;

// Premiere wraps the FlatBuffer in a 12-byte header: length, zero, and this marker.
const HEADER_BYTES = 12;
const MARKER = 0x11223344;

class Reader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Where the object an offset field at `position` points to starts. */
  follow(position: number): number {
    return position + this.view.getUint32(position, true);
  }

  /** The position of field `index` in the table at `table`, or undefined when it is unset. */
  field(table: number, index: number): number | undefined {
    const vtable = table - this.view.getInt32(table, true);
    const slot = 4 + index * 2;
    if (slot + 2 > this.view.getUint16(vtable, true)) return undefined;
    const offset = this.view.getUint16(vtable + slot, true);
    return offset === 0 ? undefined : table + offset;
  }

  child(table: number, index: number): number | undefined {
    const at = this.field(table, index);
    return at === undefined ? undefined : this.follow(at);
  }

  /** Positions of the offset slots of a vector of tables or strings. */
  vector(table: number, index: number): ReadonlyArray<number> {
    const at = this.child(table, index);
    if (at === undefined) return [];
    const length = this.view.getUint32(at, true);
    if (length > 4096) throw new RangeError("vector too long");
    return Array.from({ length }, (_, element) => this.follow(at + 4 + element * 4));
  }

  string(position: number | undefined): string | undefined {
    if (position === undefined) return undefined;
    const length = this.view.getUint32(position, true);
    if (position + 4 + length > this.bytes.length) throw new RangeError("string past the end");
    return NodeBuffer.Buffer.from(
      this.bytes.subarray(position + 4, position + 4 + length),
    ).toString("utf8");
  }

  float(table: number, index: number): number | undefined {
    const at = this.field(table, index);
    return at === undefined ? undefined : this.view.getFloat32(at, true);
  }

  uint(table: number, index: number): number | undefined {
    const at = this.field(table, index);
    return at === undefined ? undefined : this.view.getUint32(at, true);
  }

  byte(table: number, index: number): number | undefined {
    const at = this.field(table, index);
    return at === undefined ? undefined : this.view.getUint8(at);
  }

  colour(table: number, index: number): string | undefined {
    const at = this.child(table, index);
    if (at === undefined) return undefined;
    return `#${[0, 1, 2]
      .map((channel) => (this.byte(at, channel) ?? 255).toString(16).padStart(2, "0"))
      .join("")}`;
  }
}

const round = (value: number) => Math.round(value * 100) / 100;

// The Adobe text engine's paragraph justification.
const ALIGN: Readonly<Record<number, TextStyle["align"]>> = { 0: "left", 1: "right", 2: "center" };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hex = (colour: unknown): string | undefined =>
  typeof colour === "number" ? `#${(colour & 0xffffff).toString(16).padStart(6, "0")}` : undefined;

const number = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** The JSON form: one string, and per property a list of [first character, value] ranges. */
const readJsonTextStyle = (bytes: NodeBuffer.Buffer): TextStyle | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.subarray(8).toString("utf16le").replace(/\0+$/, ""));
  } catch {
    return undefined;
  }
  const param = isRecord(parsed) ? parsed["mTextParam"] : undefined;
  const sheet = isRecord(param) ? param["mStyleSheet"] : undefined;
  if (!isRecord(param) || !isRecord(sheet) || typeof sheet["mText"] !== "string") return undefined;
  const words = sheet["mText"];
  const ranges = (key: string): ReadonlyArray<readonly [number, unknown]> => {
    const group = sheet[key];
    const values = isRecord(group) ? group["mParamValues"] : undefined;
    return Array.isArray(values)
      ? values.flatMap((entry) =>
          Array.isArray(entry) && typeof entry[0] === "number"
            ? [[entry[0], entry[1]] as const]
            : [],
        )
      : [];
  };
  const keys = [
    "mFontName",
    "mFontSize",
    "mFillColor",
    "mFillVisible",
    "mStrokeColor",
    "mStrokeVisible",
    "mStrokeWidth",
  ] as const;
  const byKey = new Map(keys.map((key) => [key, ranges(key)]));
  const at = (key: (typeof keys)[number], index: number) =>
    byKey.get(key)?.findLast(([from]) => from <= index)?.[1];
  const starts = [
    ...new Set([0, ...[...byKey.values()].flatMap((list) => list.map(([from]) => from))]),
  ]
    .filter((index) => index < Math.max(1, words.length))
    .toSorted((a, b) => a - b);
  const runs = starts.map((from, position): TextRun => {
    const font = at("mFontName", from);
    const size = at("mFontSize", from);
    const fill = at("mFillVisible", from) === false ? "none" : hex(at("mFillColor", from));
    return {
      text: words.slice(from, starts[position + 1]),
      ...(typeof font === "string" && font !== "" ? { font } : {}),
      ...(typeof size === "number" ? { size: round(size) } : {}),
      ...(fill === undefined ? {} : { fill }),
      ...(at("mStrokeVisible", from) === true
        ? {
            stroke: {
              color: hex(at("mStrokeColor", from)) ?? "#ffffff",
              width: round(number(at("mStrokeWidth", from), 1)),
            },
          }
        : {}),
    };
  });
  return {
    align: ALIGN[number(param["mAlignment"], 0)] ?? "left",
    runs,
    ...(param["mShadowVisible"] === true
      ? {
          shadow: {
            color: hex(param["mShadowColor"]) ?? "#000000",
            opacity: round(number(param["mShadowOpacity"], 75) / 100),
            angle: round(number(param["mShadowAngle"], 135)),
            distance: round(number(param["mShadowOffset"], 7)),
            blur: round(number(param["mShadowBlur"], 40)),
          },
        }
      : {}),
    ...(param["mBackFillVisible"] === true
      ? {
          background: {
            color: hex(param["mBackFillColor"]) ?? "#000000",
            opacity: round(number(param["mBackFillOpacity"], 75) / 100),
            padding: round(number(param["mBackFillSize"], 0)),
          },
        }
      : {}),
  };
};

/** The runs and look of a text blob, or undefined when it is in neither form described above. */
export const readTextStyle = (base64: string): TextStyle | undefined => {
  const bytes = NodeBuffer.Buffer.from(base64, "base64");
  if (bytes.length < HEADER_BYTES + 8) return undefined;
  if (bytes[8] === 0x7b && bytes[9] === 0) return readJsonTextStyle(bytes);
  if (bytes.readUInt32LE(8) !== MARKER) return undefined;
  try {
    const reader = new Reader(bytes.subarray(HEADER_BYTES));
    const document = reader.child(reader.follow(0), 0);
    if (document === undefined) return undefined;
    const fonts = reader.vector(document, DOCUMENT.fonts).map((at) => reader.string(at) ?? "");
    const runs = reader.vector(document, DOCUMENT.runs).flatMap((run): Array<TextRun> => {
      const words = reader.string(reader.child(run, RUN.text));
      if (words === undefined) return [];
      const style = reader.child(run, RUN.style);
      if (style === undefined) return [{ text: words }];
      const font = fonts[reader.uint(style, STYLE.font) ?? 0];
      const size = reader.float(style, STYLE.size);
      const fill = reader.colour(style, STYLE.fill);
      const strokeOn = reader.byte(style, STYLE.strokeOn) === 1;
      return [
        {
          text: words,
          ...(font === undefined || font === "" ? {} : { font }),
          ...(size === undefined ? {} : { size: round(size) }),
          ...(fill === undefined ? {} : { fill }),
          ...(strokeOn
            ? {
                stroke: {
                  color: reader.colour(style, STYLE.strokeColour) ?? "#ffffff",
                  width: round(reader.float(style, STYLE.strokeWidth) ?? 1),
                },
              }
            : {}),
        },
      ];
    });
    if (runs.length === 0) return undefined;
    const shadowOn = reader.byte(document, DOCUMENT.shadowOn) === 1;
    return {
      align: ALIGN[reader.uint(document, DOCUMENT.justification) ?? 0] ?? "left",
      runs,
      ...(shadowOn
        ? {
            shadow: {
              color: reader.colour(document, DOCUMENT.shadowColour) ?? "#000000",
              opacity: round((reader.float(document, DOCUMENT.shadowOpacity) ?? 75) / 100),
              angle: round(reader.float(document, DOCUMENT.shadowAngle) ?? 135),
              distance: round(reader.float(document, DOCUMENT.shadowDistance) ?? 7),
              blur: round(reader.float(document, DOCUMENT.shadowBlur) ?? 40),
            },
          }
        : {}),
    };
  } catch {
    // Offsets that run off the buffer mean this is some other layout; the caller falls back.
    return undefined;
  }
};

/** The words of a style's runs as one string, lines separated by "\r" as Premiere keeps them. */
export const textOfRuns = (style: TextStyle): string =>
  style.runs
    .map((run) => run.text)
    .join("")
    .replace(/\r$/, "");
