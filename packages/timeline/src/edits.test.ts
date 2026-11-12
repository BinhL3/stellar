import { describe, expect, it } from "vite-plus/test";

import { applyEdits, rippleDeleteBlocked } from "./edits.ts";
import { layoutTimeline } from "./layout.ts";
import { type Clip, type Gap, rationalTime, type Timeline, timeRange, type Track } from "./otio.ts";
import { linearTimeWarp, timeScalarOf } from "./speed.ts";

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

// V1: a 0–30, gap, b 60–90.  V2: c 10–40.  A1: d 0–30.
const timeline: Timeline = {
  OTIO_SCHEMA: "Timeline.1",
  name: "t",
  global_start_time: rationalTime(0, RATE),
  tracks: {
    OTIO_SCHEMA: "Stack.1",
    name: "tracks",
    enabled: true,
    metadata: {},
    children: [
      track("V1", "Video", [clip("a", 100, 30), gap(30), clip("b", 0, 30)]),
      track("V2", "Video", [gap(10), clip("c", 50, 30)]),
      track("A1", "Audio", [clip("d", 0, 30, "d.wav")]),
    ],
  },
  metadata: {},
};

/** Each track as `id start–end src` for the clips on it. */
const spans = (edited: Timeline) =>
  Object.fromEntries(
    layoutTimeline(edited).tracks.map((t) => [
      t.name,
      t.clips.map(
        (c) => `${c.key} ${c.startFrame}–${c.endFrame} src ${c.clip.source_range.start_time.value}`,
      ),
    ]),
  );

describe("applyEdits", () => {
  it("moves a clip to another track, overwriting and splitting what it lands on", () => {
    const edited = applyEdits(timeline, [
      { kind: "move", clipId: "c", toTrack: "V1", startFrame: 15 },
    ]);
    expect(spans(edited)).toMatchObject({
      V1: ["a 0–15 src 100", "c 15–45 src 50", "b 60–90 src 0"],
      V2: [],
    });
  });

  it("splits a clip a move lands inside, keeping both ends' source in sync", () => {
    const edited = applyEdits(timeline, [
      { kind: "move", clipId: "b", toTrack: "V1", startFrame: 0 },
      { kind: "move", clipId: "c", toTrack: "V1", startFrame: 5 },
    ]);
    // b now covers 0–30; c lands on 5–35, leaving b's head and a sliver of a.
    expect(spans(edited).V1).toEqual(["b 0–5 src 0", "c 5–35 src 50"]);
  });

  it("trims a start through the source, stopping at the media's first frame", () => {
    const later = applyEdits(timeline, [{ kind: "trim", clipId: "b", edge: "start", frame: 70 }]);
    expect(spans(later).V1).toContain("b 70–90 src 10");
    // b's source starts at 0, so its start can't move earlier than 60.
    const earlier = applyEdits(timeline, [{ kind: "trim", clipId: "b", edge: "start", frame: 40 }]);
    expect(spans(earlier).V1).toContain("b 60–90 src 0");
  });

  it("stops an end trim at the next clip", () => {
    const edited = applyEdits(timeline, [{ kind: "trim", clipId: "a", edge: "end", frame: 80 }]);
    expect(spans(edited).V1).toEqual(["a 0–60 src 100", "b 60–90 src 0"]);
  });

  it("deletes a clip, leaving a gap, and keeps audio and video apart", () => {
    const edited = applyEdits(timeline, [
      { kind: "delete", clipId: "a" },
      { kind: "move", clipId: "d", toTrack: "V2", startFrame: 0 },
    ]);
    expect(spans(edited)).toMatchObject({ V1: ["b 60–90 src 0"], A1: ["d 0–30 src 0"] });
  });

  it("keeps the record times the compact view reads in step with the edit", () => {
    const edited = applyEdits(timeline, [
      { kind: "move", clipId: "c", toTrack: "V2", startFrame: 100 },
    ]);
    const moved = layoutTimeline(edited).tracks.find((t) => t.name === "V2")?.clips[0];
    expect(moved?.clip.metadata["premiere"]).toMatchObject({
      record: { startFrame: 100, endFrame: 130 },
    });
  });

  it("splits every clip under the frame, or only on the named tracks", () => {
    const all = applyEdits(timeline, [{ kind: "split", frame: 20 }]);
    expect(spans(all)).toMatchObject({
      V1: ["a 0–20 src 100", "a~20 20–30 src 120", "b 60–90 src 0"],
      V2: ["c 10–20 src 50", "c~20 20–40 src 60"],
      A1: ["d 0–20 src 0", "d~20 20–30 src 20"],
    });
    const onlyV2 = applyEdits(timeline, [{ kind: "split", frame: 20, tracks: ["V2"] }]);
    expect(spans(onlyV2).V1).toEqual(["a 0–30 src 100", "b 60–90 src 0"]);
  });

  it("lifts a range leaving a gap, and extracts it pulling everything after left", () => {
    const lifted = applyEdits(timeline, [
      { kind: "removeRange", start: 20, end: 70, ripple: false },
    ]);
    expect(spans(lifted)).toMatchObject({
      V1: ["a 0–20 src 100", "b 70–90 src 10"],
      V2: ["c 10–20 src 50"],
    });
    const extracted = applyEdits(timeline, [
      { kind: "removeRange", start: 20, end: 70, ripple: true },
    ]);
    expect(spans(extracted)).toMatchObject({
      V1: ["a 0–20 src 100", "b 20–40 src 10"],
      V2: ["c 10–20 src 50"],
      A1: ["d 0–20 src 0"],
    });
  });

  it("ripple deletes only when no other track has a clip in the gap", () => {
    // b (60–90) has nothing beside it on V2 or A1, so later clips would slide; here none follow.
    expect(rippleDeleteBlocked(timeline, "b")).toBe(false);
    expect(spans(applyEdits(timeline, [{ kind: "rippleDelete", clipId: "b" }])).V1).toEqual([
      "a 0–30 src 100",
    ]);
    // a (0–30) shares its span with c on V2 and d on A1: blocked, and the edit changes nothing.
    expect(rippleDeleteBlocked(timeline, "a")).toBe(true);
    expect(spans(applyEdits(timeline, [{ kind: "rippleDelete", clipId: "a" }])).V1).toEqual([
      "a 0–30 src 100",
      "b 60–90 src 0",
    ]);
  });

  it("disables and re-enables a clip in place", () => {
    const off = applyEdits(timeline, [{ kind: "setEnabled", clipId: "c", enabled: false }]);
    expect(layoutTimeline(off).tracks.find((t) => t.name === "V2")?.clips[0]?.clip.enabled).toBe(
      false,
    );
  });

  it("sets a text graphic's words, keeping its place and its other metadata", () => {
    const edited = applyEdits(timeline, [
      { kind: "setText", clipId: "c", text: "SF got Uniqlo back" },
    ]);
    const clip = layoutTimeline(edited).tracks.find((t) => t.name === "V2")?.clips[0];
    expect(clip?.startFrame).toBe(10);
    expect(clip?.clip.metadata).toMatchObject({
      stellar: { text: "SF got Uniqlo back" },
      premiere: { nodeId: "c" },
    });
  });

  it("moves magnetically: closes the old gap and slots in at a boundary, pushing clips along", () => {
    // Moving a (0–30) to frame 70 on V1: the gap closes (b slides to 30–60), then 70 falls
    // inside nothing, so a lands at 70 without overwriting anything.
    const later = applyEdits(timeline, [
      { kind: "move", clipId: "a", toTrack: "V1", startFrame: 70, magnetic: true },
    ]);
    expect(spans(later).V1).toEqual(["b 30–60 src 0", "a 70–100 src 100"]);
    // Dropping c (30 frames) at 65 lands inside b (60–90): it snaps to b's nearer edge, 60,
    // and pushes b to 90–120 instead of cutting it.
    const into = applyEdits(timeline, [
      { kind: "move", clipId: "c", toTrack: "V1", startFrame: 65, magnetic: true },
    ]);
    expect(spans(into)).toMatchObject({
      V1: ["a 0–30 src 100", "c 60–90 src 50", "b 90–120 src 0"],
      V2: [],
    });
  });

  it("cuts and trims sped-up and reversed clips by the source frames they play", () => {
    const warped = (speed: number): Timeline => ({
      ...timeline,
      tracks: {
        ...timeline.tracks,
        children: [
          track("V1", "Video", [{ ...clip("a", 100, 30), effects: [linearTimeWarp(speed)] }]),
        ],
      },
    });
    const sources = (edited: Timeline) =>
      layoutTimeline(edited).tracks[0]?.clips.map((item) => [
        item.startFrame,
        item.endFrame,
        item.clip.source_range.start_time.value,
        timeScalarOf(item.clip),
      ]);
    // Double speed plays source 100-160: a cut at frame 10 lands on source 120.
    expect(sources(applyEdits(warped(2), [{ kind: "split", frame: 10 }]))).toEqual([
      [0, 10, 100, 2],
      [10, 30, 120, 2],
    ]);
    // Reversed, the first piece is the end of the media and the second its start.
    expect(sources(applyEdits(warped(-1), [{ kind: "split", frame: 10 }]))).toEqual([
      [0, 10, 120, -1],
      [10, 30, 100, -1],
    ]);
    expect(
      sources(applyEdits(warped(2), [{ kind: "trim", clipId: "a", edge: "start", frame: 5 }])),
    ).toEqual([[5, 30, 110, 2]]);
    // A reversed clip's tail runs toward the media's first frame: 100 source frames are left.
    expect(
      sources(applyEdits(warped(-2), [{ kind: "trim", clipId: "a", edge: "end", frame: 500 }])),
    ).toEqual([[0, 80, 0, -2]]);
  });
});
