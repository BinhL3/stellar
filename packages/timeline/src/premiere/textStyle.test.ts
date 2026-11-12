import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "vite-plus/test";

import { readTextStyle, textOfRuns } from "./textStyle.ts";

type Field = { readonly u32: number } | { readonly f32: number } | Node | undefined;
type Node =
  | { readonly table: ReadonlyArray<Field> }
  | { readonly text: string }
  | { readonly list: ReadonlyArray<Node> };

/** A FlatBuffer laid out front to back: every field takes four bytes, offsets point forward. */
const flatBuffer = (root: Node): NodeBuffer.Buffer => {
  const bytes: Array<number> = [0, 0, 0, 0];
  const put = (at: number, value: number, kind: "u32" | "i32" | "f32" | "u16") => {
    const scratch = NodeBuffer.Buffer.alloc(4);
    if (kind === "f32") scratch.writeFloatLE(value);
    else if (kind === "i32") scratch.writeInt32LE(value);
    else if (kind === "u16") scratch.writeUInt16LE(value);
    else scratch.writeUInt32LE(value);
    for (let index = 0; index < (kind === "u16" ? 2 : 4); index++)
      bytes[at + index] = scratch[index]!;
  };
  const grow = (count: number) => {
    const at = bytes.length;
    for (let index = 0; index < count; index++) bytes.push(0);
    return at;
  };
  const isNode = (field: Field): field is Node =>
    field !== undefined && !("u32" in field) && !("f32" in field);
  const emit = (node: Node): number => {
    while (bytes.length % 4 !== 0) bytes.push(0);
    if ("text" in node) {
      const encoded = NodeBuffer.Buffer.from(node.text, "utf8");
      const at = grow(4 + encoded.length + 1);
      put(at, encoded.length, "u32");
      encoded.forEach((byte, index) => (bytes[at + 4 + index] = byte));
      return at;
    }
    if ("list" in node) {
      const at = grow(4 + node.list.length * 4);
      put(at, node.list.length, "u32");
      node.list.forEach((child, index) => {
        const slot = at + 4 + index * 4;
        put(slot, emit(child) - slot, "u32");
      });
      return at;
    }
    const vtableSize = 4 + node.table.length * 2 + ((node.table.length * 2) % 4);
    const vtable = grow(vtableSize);
    const table = grow(4 + node.table.length * 4);
    put(vtable, 4 + node.table.length * 2, "u16");
    put(vtable + 2, 4 + node.table.length * 4, "u16");
    put(table, table - vtable, "i32");
    node.table.forEach((field, index) => {
      if (field === undefined) return;
      const slot = table + 4 + index * 4;
      put(vtable + 4 + index * 2, slot - table, "u16");
      if ("u32" in field) put(slot, field.u32, "u32");
      else if ("f32" in field) put(slot, field.f32, "f32");
    });
    node.table.forEach((field, index) => {
      if (!isNode(field)) return;
      const slot = table + 4 + index * 4;
      put(slot, emit(field) - slot, "u32");
    });
    return table;
  };
  put(0, emit(root), "u32");
  return NodeBuffer.Buffer.from(bytes);
};

/** Premiere's wrapper: length, zero, a marker, then the buffer. */
const sourceText = (document: ReadonlyArray<Field>): string => {
  const body = flatBuffer({ table: [{ table: document }] });
  const header = NodeBuffer.Buffer.alloc(12);
  header.writeUInt32LE(body.length + 4, 0);
  header.writeUInt32LE(0x11223344, 8);
  return NodeBuffer.Buffer.concat([header, body]).toString("base64");
};

const colour = (red: number | undefined, green: number, blue: number): Node => ({
  table: [red === undefined ? undefined : { u32: red }, { u32: green }, { u32: blue }],
});

describe("readTextStyle", () => {
  it("reads runs with their font, size, fill and stroke, and the layer's alignment and shadow", () => {
    const title: ReadonlyArray<Field> = [undefined, { f32: 98.2 }];
    const link: ReadonlyArray<Field> = [
      { u32: 1 },
      { f32: 52.06 },
      colour(0, 0, 0),
      undefined,
      // A colour channel left out is 255: this stroke is red.
      colour(undefined, 0, 0),
      { u32: 1 },
      { f32: 7 },
    ];
    const document: Array<Field> = [
      {
        list: [
          { table: [{ text: "Xin chào\r" }, { table: title }] },
          { table: [{ text: "stellar.example" }, { table: link }] },
        ],
      },
      { list: [{ text: "BeVietnamPro-Bold" }, { text: "BeVietnamPro-Italic" }] },
    ];
    document[4] = { u32: 2 };
    document[10] = colour(0, 0, 0);
    document[11] = { u32: 1 };
    document[12] = { f32: 90 };
    document[14] = { f32: 3 };
    document[16] = { f32: 28 };
    const style = readTextStyle(sourceText(document));
    expect(style).toEqual({
      align: "center",
      runs: [
        { text: "Xin chào\r", font: "BeVietnamPro-Bold", size: 98.2 },
        {
          text: "stellar.example",
          font: "BeVietnamPro-Italic",
          size: 52.06,
          fill: "#000000",
          stroke: { color: "#ff0000", width: 7 },
        },
      ],
      shadow: { color: "#000000", opacity: 0.9, angle: 135, distance: 3, blur: 28 },
    });
    expect(style === undefined ? "" : textOfRuns(style)).toBe("Xin chào\rstellar.example");
  });

  it("reads the JSON form, where each property lists the character it starts at", () => {
    const ranges = (...values: ReadonlyArray<readonly [number, unknown]>) => ({
      mParamValues: values,
    });
    const json = JSON.stringify({
      mTextParam: {
        mAlignment: 1,
        mBackFillVisible: true,
        mBackFillColor: 0x101010,
        mBackFillOpacity: 75,
        mBackFillSize: 12,
        mShadowVisible: false,
        mStyleSheet: {
          mText: "ONE two",
          mFontName: ranges([0, "Arial-BoldMT"]),
          mFontSize: ranges([0, 60], [4, 40]),
          mFillColor: ranges([0, 0xffcc00]),
          mFillVisible: ranges([0, true]),
          mStrokeVisible: ranges([0, false]),
        },
      },
    });
    const body = NodeBuffer.Buffer.from(json, "utf16le");
    const header = NodeBuffer.Buffer.alloc(8);
    header.writeUInt32LE(body.length, 0);
    expect(readTextStyle(NodeBuffer.Buffer.concat([header, body]).toString("base64"))).toEqual({
      align: "right",
      runs: [
        { text: "ONE ", font: "Arial-BoldMT", size: 60, fill: "#ffcc00" },
        { text: "two", font: "Arial-BoldMT", size: 40, fill: "#ffcc00" },
      ],
      background: { color: "#101010", opacity: 0.75, padding: 12 },
    });
  });

  it("gives up on anything else rather than guess", () => {
    expect(readTextStyle("")).toBeUndefined();
    expect(readTextStyle(NodeBuffer.Buffer.alloc(64).toString("base64"))).toBeUndefined();
    // The marker with offsets that run off the buffer.
    const broken = NodeBuffer.Buffer.alloc(24, 0xff);
    broken.writeUInt32LE(0x11223344, 8);
    expect(readTextStyle(broken.toString("base64"))).toBeUndefined();
  });
});
