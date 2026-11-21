import { describe, expect, it } from "vite-plus/test";

import { clipFraming, largeSpeedChanges, placedText, textInSafeZones } from "./framing.ts";
import { type Clip, rationalTime, type Timeline, timeRange, type Track } from "./otio.ts";
import { safeZoneInsets } from "./safeZones.ts";
import { linearTimeWarp } from "./speed.ts";

const RATE = 30;
const FRAME = { width: 1080, height: 1920 };

const clip = (name: string, stellar: Record<string, unknown> = {}, scalar = 1): Clip => ({
  OTIO_SCHEMA: "Clip.2",
  name,
  source_range: timeRange(0, 30, RATE),
  ...(scalar === 1 ? {} : { effects: [linearTimeWarp(scalar)] }),
  media_references: {
    DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: name, metadata: {} },
  },
  active_media_reference_key: "DEFAULT_MEDIA",
  enabled: true,
  metadata: { stellar },
});

const timelineOf = (...tracks: ReadonlyArray<Track>): Timeline => ({
  OTIO_SCHEMA: "Timeline.1",
  name: "Short",
  global_start_time: rationalTime(0, RATE),
  tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", enabled: true, metadata: {}, children: tracks },
  metadata: { stellar: { frame: FRAME } },
});

const video = (...children: ReadonlyArray<Clip>): Track => ({
  OTIO_SCHEMA: "Track.1",
  name: "V1",
  kind: "Video",
  children,
  enabled: true,
  metadata: {},
});

describe("clipFraming", () => {
  const sizes = new Map([
    ["wide.mov", { width: 1920, height: 1080 }],
    ["tall.mov", { width: 1080, height: 1920 }],
    ["4k.mov", { width: 2160, height: 3840 }],
  ]);
  const framing = (stellar: Record<string, unknown>, name = "wide.mov") =>
    clipFraming(timelineOf(video(clip(name, stellar))), FRAME, sizes);

  it("skips a clip already the frame's size", () => {
    expect(framing({}, "tall.mov")).toEqual([]);
  });

  it("measures a 16:9 clip in a 9:16 frame as Premiere places it, at its own pixel size", () => {
    const [placed] = framing({});
    expect(placed?.outside).toBeCloseTo(1 - 1080 / 1920);
    expect(placed?.uncovered).toBeCloseTo(1 - 1080 / 1920);
  });

  it("follows Motion's scale and position", () => {
    const [filled] = framing({ transform: { scale: (1920 / 1080) * 100 } });
    expect(filled?.outside).toBeCloseTo(1 - 1080 / ((1920 * 1920) / 1080));
    expect(filled?.uncovered).toBeCloseTo(0);
    const [halfOff] = framing({ transform: { scale: 50, position: [1, 0.5] } }, "4k.mov");
    expect(halfOff?.uncovered).toBeCloseTo(0.5);
    const [animated] = framing({ transform: { keyframes: { scale: [[0, 100]] } } });
    expect(animated?.animated).toBe(true);
  });

  it("turns a picture stored sideways before measuring it", () => {
    expect(framing({ mediaRotation: 90 })).toEqual([]);
    const [fourK] = framing({ transform: { scale: 50 } }, "4k.mov");
    expect([fourK?.outside, fourK?.uncovered]).toEqual([0, 0]);
  });
});

describe("largeSpeedChanges", () => {
  it("lists clips at a large speed or backwards, linked picture and sound once", () => {
    const sound: Track = {
      ...video(clip("a.mov", {}, 1.1), clip("b.mov", {}, 2)),
      name: "A1",
      kind: "Audio",
    };
    const changes = largeSpeedChanges(
      timelineOf(
        video(
          clip("a.mov", {}, 1.1),
          clip("b.mov", {}, 2),
          clip("c.mov", {}, 0.5),
          clip("d.mov", {}, -1),
        ),
        sound,
      ),
    );
    expect(changes.map((change) => [change.name, change.startFrame, change.scalar])).toEqual([
      ["b.mov", 30, 2],
      ["c.mov", 60, 0.5],
      ["d.mov", 90, -1],
    ]);
  });
});

describe("text in the safe zones", () => {
  const text = (words: string, y: number) =>
    clip("", {
      text: words,
      textPosition: [0.5, y],
      textStyle: { align: "center", runs: [{ text: words, size: 80 }] },
    });

  it("estimates where words sit and flags those under an app's buttons", () => {
    const captions: Track = { ...video(), name: "C1", metadata: { stellar: { captions: true } } };
    const texts = placedText(
      timelineOf(video(text("Hãy subscribe", 0.5), text("cho kênh", 0.9)), {
        ...captions,
        children: [clip("", { caption: true, text: "Ghiền Mì Gõ" })],
      }),
      FRAME,
    );
    expect(texts.filter((placed) => placed.box === null).map((placed) => placed.text)).toEqual([
      "Ghiền Mì Gõ",
    ]);
    const covered = textInSafeZones(texts, safeZoneInsets());
    expect(covered.map(({ text: placed, edges }) => [placed.text, edges])).toEqual([
      ["cho kênh", ["bottom"]],
    ]);
  });
});
