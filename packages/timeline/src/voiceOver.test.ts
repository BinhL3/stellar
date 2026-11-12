import { describe, expect, it } from "vite-plus/test";

import { applyEdits } from "./edits.ts";
import { layoutTimeline } from "./layout.ts";
import { type Clip, type Gap, rationalTime, type Timeline, timeRange, type Track } from "./otio.ts";
import {
  addTake,
  chooseTake,
  nextTakeId,
  NO_TAKES,
  placedVoiceOver,
  placeTake,
  removeTake,
  sliceByBeats,
  takesOnTimeline,
  type VoiceOverTake,
} from "./voiceOver.ts";

const RATE = 30;

const clip = (id: string, sourceStart: number, frames: number, url = `${id}.mov`): Clip => ({
  OTIO_SCHEMA: "Clip.2",
  name: id,
  source_range: timeRange(sourceStart, frames, RATE),
  media_references: {
    DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: url, metadata: {} },
  },
  active_media_reference_key: "DEFAULT_MEDIA",
  enabled: true,
  metadata: { premiere: { nodeId: id } },
});

const gap = (frames: number): Gap => ({
  OTIO_SCHEMA: "Gap.1",
  name: "",
  source_range: timeRange(0, frames, RATE),
  enabled: true,
  metadata: {},
});

const track = (name: string, kind: Track["kind"], children: Track["children"]): Track => ({
  OTIO_SCHEMA: "Track.1",
  name,
  kind,
  children,
  enabled: true,
  metadata: {},
});

const timelineOf = (...children: ReadonlyArray<Track>): Timeline => ({
  OTIO_SCHEMA: "Timeline.1",
  name: "t",
  global_start_time: rationalTime(0, RATE),
  tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", enabled: true, metadata: {}, children },
  metadata: {},
});

const take = (id: string, beatId: string, frames: number, createdAt = 0): VoiceOverTake => ({
  id,
  beatId,
  file: `Audio/VO/VO ${beatId} ${id}.wav`,
  seconds: frames / RATE,
  source: "recorded",
  createdAt,
});

const t1 = take("t1", "b1", 90);
const t2 = take("t2", "b2", 80);
const t3 = take("t3", "b3", 90);
const voice = (of: VoiceOverTake, frames: number) => clip(`vo-${of.id}`, 0, frames, of.file);

// Three lines back to back. b2 (90-170) has two shots under it, a b-roll clip that starts in it
// and runs into b3, and music under everything.
const cut = timelineOf(
  track("V1", "Video", [
    clip("shot1", 0, 90),
    clip("shot2a", 10, 40),
    clip("shot2b", 0, 40),
    clip("shot3", 20, 90),
  ]),
  track("V2", "Video", [gap(130), clip("broll", 5, 70)]),
  track("A1", "Audio", [clip("music", 0, 260, "music.wav")]),
  track("A2", "Audio", [voice(t1, 90), voice(t2, 80), voice(t3, 90)]),
);
const ORDER = ["b1", "b2", "b3"];
const plenty = () => 600;

/** Each track as `id start-end src` for the clips on it. */
const spans = (timeline: Timeline) =>
  Object.fromEntries(
    layoutTimeline(timeline).tracks.map((laid) => [
      laid.name,
      laid.clips.map(
        (item) =>
          `${item.key} ${item.startFrame}-${item.endFrame} src ${item.clip.source_range.start_time.value}`,
      ),
    ]),
  );

const place = (
  timeline: Timeline,
  chosen: VoiceOverTake,
  takes: ReadonlyArray<VoiceOverTake>,
  mediaSeconds: (target: string) => number | undefined = plenty,
) => {
  const placement = placeTake(timeline, { take: chosen, takes, order: ORDER, mediaSeconds });
  if (typeof placement === "string") throw new Error(placement);
  return placement;
};

describe("the take index", () => {
  it("uses a line's newest take until another is chosen, and never reuses an id", () => {
    const first = addTake(NO_TAKES, take(nextTakeId(NO_TAKES), "b1", 60, 1));
    const second = addTake(first, take(nextTakeId(first), "b1", 70, 2));
    expect(second.chosen).toEqual({ b1: "t2" });

    const back = chooseTake(second, "b1", "t1");
    expect(back).toMatchObject({ chosen: { b1: "t1" } });
    expect(chooseTake(second, "b2", "t1")).toBe("take t1 was recorded for b1, not b2");
    expect(chooseTake(second, "b1", "t9")).toBe("no take t9");

    const removed = removeTake(second, "t2");
    expect(removed).toMatchObject({ chosen: { b1: "t1" }, takes: [{ id: "t1" }] });
    if (typeof removed === "string") throw new Error(removed);
    expect(nextTakeId(removed)).toBe("t3");
    expect(removeTake(removed, "t1")).toMatchObject({ chosen: {}, takes: [] });
  });
});

describe("placedVoiceOver", () => {
  it("finds a beat's clips by their take file, wherever the path is rooted", () => {
    const pulled = timelineOf(
      track("A1", "Audio", [gap(10), clip("left", 0, 80, `/Volumes/SSD/Short/${t2.file}`)]),
      track("A2", "Audio", [gap(10), clip("right", 0, 80, `/Volumes/SSD/Short/${t2.file}`)]),
    );
    expect(placedVoiceOver(pulled, [t1, t2]).get("b2")).toEqual({
      beatId: "b2",
      takeId: "t2",
      track: "A1",
      startFrame: 10,
      endFrame: 90,
      clipIds: ["left", "right"],
    });
    expect([...takesOnTimeline(pulled, [t1, t2])]).toEqual(["t2"]);
  });
});

describe("placeTake", () => {
  it("re-recording one line re-times only that beat", () => {
    const longer = take("t4", "b2", 110);
    const placement = place(cut, longer, [t1, t2, t3, longer]);

    expect(spans(placement.timeline)).toEqual({
      V2: ["broll 145-230 src 5"],
      V1: [
        "shot1 0-90 src 0",
        "shot2a 90-145 src 10",
        "shot2b 145-200 src 0",
        "shot3 200-290 src 20",
      ],
      A1: ["music 0-290 src 0"],
      A2: ["vo-t1 0-90 src 0", "vo-b2-t4 90-200 src 0", "vo-t3 200-290 src 0"],
    });
    expect(placement).toMatchObject({
      track: "A2",
      startFrame: 90,
      endFrame: 200,
      previousFrames: 80,
      movedBy: 30,
      short: [],
    });
    expect(applyEdits(placement.prepared, placement.edits)).toEqual(placement.timeline);
    expect(placedVoiceOver(placement.timeline, [t1, t2, t3, longer]).get("b2")?.takeId).toBe("t4");
  });

  it("a shorter take pulls the beat's cut points in and everything after it earlier", () => {
    const shorter = take("t4", "b2", 40);
    expect(spans(place(cut, shorter, [t1, t2, t3, shorter]).timeline)).toEqual({
      V2: ["broll 110-160 src 5"],
      V1: [
        "shot1 0-90 src 0",
        "shot2a 90-110 src 10",
        "shot2b 110-130 src 0",
        "shot3 130-220 src 20",
      ],
      A1: ["music 0-220 src 0"],
      A2: ["vo-t1 0-90 src 0", "vo-b2-t4 90-130 src 0", "vo-t3 130-220 src 0"],
    });
  });

  it("leaves a gap, and says so, where a clip has no more source to stretch into", () => {
    const longer = take("t4", "b2", 110);
    // shot2b's file ends 5 frames after its out point; the music's length isn't known.
    const placement = place(cut, longer, [t1, t2, t3, longer], (target) =>
      target === "shot2b.mov" ? 45 / RATE : target === "music.wav" ? undefined : 600,
    );
    const { V1, A1 } = spans(placement.timeline);
    expect(V1).toEqual([
      "shot1 0-90 src 0",
      "shot2a 90-145 src 10",
      "shot2b 145-190 src 0",
      "shot3 200-290 src 20",
    ]);
    expect(A1).toEqual(["music 0-260 src 0"]);
    expect(placement.short).toEqual([
      { clipId: "shot2b", name: "shot2b", track: "V1", frames: 10, atFrame: 190 },
      { clipId: "music", name: "music", track: "A1", frames: 30, atFrame: 260 },
    ]);
  });

  it("refuses rather than leave a clip with no frames", () => {
    const withCutaway = timelineOf(
      track("V1", "Video", [gap(168), clip("blink", 0, 2)]),
      track("A1", "Audio", [voice(t1, 90), voice(t2, 80)]),
    );
    const tiny = take("t4", "b2", 10);
    expect(
      placeTake(withCutaway, {
        take: tiny,
        takes: [t1, t2, tiny],
        order: ORDER,
        mediaSeconds: plenty,
      }),
    ).toMatch(/too short for V1 #blink .* no frames/);
  });

  it("puts a first take on a new track without moving a picture that has no voice-over yet", () => {
    const picture = timelineOf(
      track("V1", "Video", [clip("shot1", 0, 300)]),
      track("A1", "Audio", [clip("camera", 0, 300, "shot1.mov")]),
    );
    const first = place(picture, t2, [t1, t2, t3]);
    expect(first).toMatchObject({ track: "A2", startFrame: 0, endFrame: 80, movedBy: 0 });
    // The next line goes after the nearest earlier one that is placed.
    const second = place(first.timeline, t3, [t1, t2, t3]);
    expect(spans(second.timeline)).toEqual({
      V1: ["shot1 0-300 src 0"],
      A1: ["camera 0-300 src 0"],
      A2: ["vo-b2-t2 0-80 src 0", "vo-b3-t3 80-170 src 0"],
    });
  });

  it("makes room for a line recorded between two that are already placed", () => {
    const voiceOnly = timelineOf(track("A1", "Audio", [voice(t1, 90), voice(t3, 90)]));
    const placement = place(voiceOnly, t2, [t1, t2, t3]);
    expect(spans(placement.timeline)).toEqual({
      A1: ["vo-t1 0-90 src 0", "vo-b2-t2 90-170 src 0", "vo-t3 170-260 src 0"],
    });
    expect(placement).toMatchObject({ previousFrames: 0, movedBy: 80 });
  });

  it("refuses a take for a line the script no longer has", () => {
    const stray = take("t9", "b9", 30);
    expect(
      placeTake(cut, { take: stray, takes: [stray], order: ORDER, mediaSeconds: plenty }),
    ).toBe("b9 is not a line of the script");
  });
});

describe("sliceByBeats", () => {
  it("cuts a whole-script recording at the lines' words, never into a neighbour's", () => {
    const words = [
      { w: "Take", start: 0.5, end: 0.7 },
      { w: "the", start: 0.7, end: 0.8 },
      { w: "rewards.", start: 0.8, end: 1.3 },
      { w: "Comment", start: 1.5, end: 1.9 },
      { w: "below.", start: 1.9, end: 2.4 },
    ];
    const slices = sliceByBeats(
      [
        { id: "b1", text: "Take the rewards." },
        { id: "b2", text: "This line was never read." },
        { id: "b3", text: "Comment below." },
      ],
      words,
    );
    expect(slices).toEqual([
      {
        beatId: "b1",
        start: 0.35,
        end: 1.4,
        words: [
          { w: "Take", start: 0.15, end: 0.35 },
          { w: "the", start: 0.35, end: 0.45 },
          { w: "rewards.", start: 0.45, end: 0.95 },
        ],
      },
      {
        beatId: "b3",
        start: 1.4,
        end: 2.7,
        words: [
          { w: "Comment", start: 0.1, end: 0.5 },
          { w: "below.", start: 0.5, end: 1 },
        ],
      },
    ]);
  });
});
