import { describe, expect, it } from "vite-plus/test";

import {
  applyEdits,
  gapAt,
  linkedTracks,
  type MediaFacts,
  placementProblem,
  rippleDeleteBlocked,
} from "./edits.ts";
import { layoutTimeline } from "./layout.ts";
import { timelineMarkers } from "./markers.ts";
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

  it("keeps Motion and Transform keyframes on their frames when a clip's head is cut", () => {
    // A slide-in over the clip's first second (frames 0-30) and a punch-in over the same span.
    const animated: Clip = {
      ...clip("a", 100, 60),
      metadata: {
        premiere: { nodeId: "a" },
        stellar: {
          transform: {
            scale: 50,
            keyframes: {
              scale: [
                [0, 100],
                [1, 120],
              ],
            },
          },
          effects: [
            { kind: "Drop Shadow", ref: "sha256:s" },
            {
              kind: "Transform",
              ref: "sha256:t",
              params: {
                rotation: 5,
                keyframes: {
                  position: [
                    [0, [0.5, -1.4], [0.0626, 1, 0, 1]],
                    [1, [0.5, 0.5]],
                  ],
                },
              },
            },
          ],
        },
      },
    };
    const one = (children: Track["children"]): Timeline => ({
      ...timeline,
      tracks: { ...timeline.tracks, children: [track("V1", "Video", children)] },
    });
    const keys = (edited: Timeline) =>
      layoutTimeline(edited).tracks[0]?.clips.map((item) => {
        const stellar = item.clip.metadata["stellar"] as {
          transform: { keyframes: { scale: ReadonlyArray<ReadonlyArray<unknown>> } };
          effects: ReadonlyArray<{
            ref: string;
            params?: { rotation: number; keyframes: { position: ReadonlyArray<unknown> } };
          }>;
        };
        return {
          at: item.startFrame,
          scale: stellar.transform.keyframes.scale.map(([at]) => at),
          position: stellar.effects[1]?.params?.keyframes.position,
          refs: stellar.effects.map((effect) => effect.ref),
          rotation: stellar.effects[1]?.params?.rotation,
        };
      });
    const untouched = {
      scale: [0, 1],
      position: [
        [0, [0.5, -1.4], [0.0626, 1, 0, 1]],
        [1, [0.5, 0.5]],
      ],
      refs: ["sha256:s", "sha256:t"],
      rotation: 5,
    };
    // Cut at frame 15: the tail starts half a second into both animations, so its keys sit
    // half a second earlier, values, easing and blob refs as they were.
    const later = {
      ...untouched,
      scale: [-0.5, 0.5],
      position: [
        [-0.5, [0.5, -1.4], [0.0626, 1, 0, 1]],
        [0.5, [0.5, 0.5]],
      ],
    };
    expect(keys(applyEdits(one([animated]), [{ kind: "split", frame: 15 }]))).toEqual([
      { at: 0, ...untouched },
      { at: 15, ...later },
    ]);
    expect(
      keys(applyEdits(one([animated]), [{ kind: "trim", clipId: "a", edge: "start", frame: 15 }])),
    ).toEqual([{ at: 15, ...later }]);
    // A word cut is a range removed with ripple: the piece after it closes up, still in step.
    expect(
      keys(applyEdits(one([animated]), [{ kind: "removeRange", start: 6, end: 15, ripple: true }])),
    ).toEqual([
      { at: 0, ...untouched },
      { at: 6, ...later },
    ]);
    // Trimming the tail or moving the clip leaves the animation where it starts.
    expect(
      keys(
        applyEdits(one([animated]), [
          { kind: "trim", clipId: "a", edge: "end", frame: 20 },
          { kind: "move", clipId: "a", toTrack: "V1", startFrame: 90 },
        ]),
      ),
    ).toEqual([{ at: 90, ...untouched }]);
  });

  it("keeps a clip's marker on its picture and its keyframes on their frames through a head trim and a cut", () => {
    // Clip a plays source 100-160 at 0-60, with a punch-in over its first second and a note
    // pinned to source frame 130, which shows at timeline frame 30.
    const noted: Clip = {
      ...clip("a", 100, 60),
      markers: [
        {
          OTIO_SCHEMA: "Marker.2",
          name: "Tighten",
          color: "RED",
          comment: "",
          marked_range: timeRange(130, 0, RATE),
          metadata: { stellar: { id: "m1", author: "user" } },
        },
      ],
      metadata: {
        premiere: { nodeId: "a" },
        stellar: {
          effects: [
            {
              kind: "Transform",
              ref: "sha256:t",
              params: {
                keyframes: {
                  scale: [
                    [0, 100],
                    [1, 120],
                  ],
                },
              },
            },
          ],
        },
      },
    };
    const edited = applyEdits(
      { ...timeline, tracks: { ...timeline.tracks, children: [track("V1", "Video", [noted])] } },
      [
        { kind: "trim", clipId: "a", edge: "start", frame: 15 },
        { kind: "split", frame: 45 },
        // A marker edit after the cuts reaches the marker on whichever piece shows it.
        { kind: "setMarker", markerId: "m1", resolved: true },
      ],
    );
    expect(
      layoutTimeline(edited).tracks[0]?.clips.map((item) => {
        const stellar = item.clip.metadata["stellar"] as {
          effects: ReadonlyArray<{
            ref: string;
            params: { keyframes: { scale: ReadonlyArray<ReadonlyArray<number>> } };
          }>;
        };
        return {
          span: `${item.key} ${item.startFrame}–${item.endFrame} src ${item.clip.source_range.start_time.value}`,
          ref: stellar.effects[0]?.ref,
          scale: stellar.effects[0]?.params.keyframes.scale,
        };
      }),
    ).toEqual([
      {
        span: "a 15–45 src 115",
        ref: "sha256:t",
        scale: [
          [-0.5, 100],
          [0.5, 120],
        ],
      },
      {
        span: "a~45 45–60 src 145",
        ref: "sha256:t",
        scale: [
          [-1.5, 100],
          [-0.5, 120],
        ],
      },
    ]);
    // The note is still on source frame 130, shown once, by the piece that plays it.
    expect(timelineMarkers(edited)).toMatchObject([
      { id: "m1", frame: 30, clipId: "a", track: "V1", name: "Tighten", resolved: true },
    ]);
  });
});

// Picture with its sound linked under it, then a gap. V1: a 0–30, b 30–60, gap, c 80–110.
// A1 plays the same media from the same frames (a, b and c's sound). A2: n 70–100.
const linked = (aV: Clip, bV: Clip, cV: Clip, extra: ReadonlyArray<Track> = []): Timeline => ({
  ...timeline,
  tracks: {
    ...timeline.tracks,
    children: [
      track("V1", "Video", [aV, bV, gap(20), cV]),
      track("A1", "Audio", [
        clip("aA", aV.source_range.start_time.value, 30, "a.mov"),
        clip("bA", bV.source_range.start_time.value, 30, "b.mov"),
        gap(20),
        clip("cA", cV.source_range.start_time.value, 30, "c.mov"),
      ]),
      track("A2", "Audio", [gap(70), clip("n", 0, 30, "n.wav")]),
      ...extra,
    ],
  },
});
const cut = linked(clip("a", 100, 30), clip("b", 200, 30), clip("c", 5, 30));
/** a.mov holds 134 frames: a (100–130) has 4 frames of tail handle. */
const mediaSeconds = (target: string) => (target === "a.mov" ? 134 / RATE : undefined);

describe("trimming tools", () => {
  it("ripple trims an end: the clip and its sound shorten, everything after closes up", () => {
    expect(
      spans(applyEdits(cut, [{ kind: "rippleTrim", clipId: "a", edge: "end", frame: 20 }])),
    ).toEqual({
      V1: ["a 0–20 src 100", "b 20–50 src 200", "c 70–100 src 5"],
      A1: ["aA 0–20 src 100", "bA 20–50 src 200", "cA 70–100 src 5"],
      A2: ["n 60–90 src 0"],
    });
  });

  it("ripple trims a start: the clip stays put, its head goes, later clips follow", () => {
    expect(
      spans(applyEdits(cut, [{ kind: "rippleTrim", clipId: "b", edge: "start", frame: 35 }])),
    ).toMatchObject({
      V1: ["a 0–30 src 100", "b 30–55 src 205", "c 75–105 src 5"],
      A1: ["aA 0–30 src 100", "bA 30–55 src 205", "cA 75–105 src 5"],
    });
    // Pulled left, the head grows from the handle and pushes the rest along; c has only 5.
    expect(
      spans(applyEdits(cut, [{ kind: "rippleTrim", clipId: "c", edge: "start", frame: 70 }])).V1,
    ).toEqual(["a 0–30 src 100", "b 30–60 src 200", "c 80–115 src 0"]);
  });

  it("ripple extends an end until the media runs out", () => {
    const longer = applyEdits(cut, [{ kind: "rippleTrim", clipId: "a", edge: "end", frame: 40 }]);
    expect(spans(longer).V1).toEqual(["a 0–40 src 100", "b 40–70 src 200", "c 90–120 src 5"]);
    const handled = applyEdits(cut, [{ kind: "rippleTrim", clipId: "a", edge: "end", frame: 40 }], {
      mediaSeconds,
    });
    expect(spans(handled)).toMatchObject({
      V1: ["a 0–34 src 100", "b 34–64 src 200", "c 84–114 src 5"],
      A2: ["n 74–104 src 0"],
    });
  });

  it("ripple trims only as far as another track's later clips have room", () => {
    // V2: t 10–40 crosses a's end and stays; u 40–50 after it can't move left of 40.
    const blocked = linked(clip("a", 100, 30), clip("b", 200, 30), clip("c", 5, 30), [
      track("V2", "Video", [gap(10), clip("t", 0, 30, "t.png"), clip("u", 0, 10, "u.png")]),
    ]);
    const edited = applyEdits(blocked, [
      { kind: "rippleTrim", clipId: "a", edge: "end", frame: 20 },
    ]);
    expect(spans(edited)).toEqual(spans(blocked));
  });

  it("rolls a cut between two clips, within both clips' media", () => {
    expect(
      spans(applyEdits(cut, [{ kind: "roll", clipId: "a", edge: "end", frame: 25 }])),
    ).toMatchObject({
      V1: ["a 0–25 src 100", "b 25–60 src 195", "c 80–110 src 5"],
      A1: ["aA 0–25 src 100", "bA 25–60 src 195", "cA 80–110 src 5"],
    });
    // Naming b's start is the same cut. Past b's last frame it stops one frame short.
    expect(
      spans(applyEdits(cut, [{ kind: "roll", clipId: "b", edge: "start", frame: 90 }])).V1,
    ).toEqual(["a 0–59 src 100", "b 59–60 src 229", "c 80–110 src 5"]);
    // a.mov has 4 frames after a's out point.
    expect(
      spans(
        applyEdits(cut, [{ kind: "roll", clipId: "a", edge: "end", frame: 40 }], { mediaSeconds }),
      ).V1,
    ).toEqual(["a 0–34 src 100", "b 34–60 src 204", "c 80–110 src 5"]);
    // c has 5 frames of head handle, so its cut rolls back only that far into the gap.
    expect(
      spans(applyEdits(cut, [{ kind: "roll", clipId: "c", edge: "start", frame: 60 }])).V1,
    ).toEqual(["a 0–30 src 100", "b 30–60 src 200", "c 75–110 src 0"]);
  });

  it("rolls into a gap up to the next clip", () => {
    expect(
      spans(applyEdits(cut, [{ kind: "roll", clipId: "b", edge: "end", frame: 95 }])).V1,
    ).toEqual(["a 0–30 src 100", "b 30–80 src 200", "c 80–110 src 5"]);
  });

  it("slips the media under a clip and its sound, stopping at the handles", () => {
    expect(spans(applyEdits(cut, [{ kind: "slip", clipId: "b", frames: 10 }]))).toMatchObject({
      V1: ["a 0–30 src 100", "b 30–60 src 210", "c 80–110 src 5"],
      A1: ["aA 0–30 src 100", "bA 30–60 src 210", "cA 80–110 src 5"],
    });
    expect(spans(applyEdits(cut, [{ kind: "slip", clipId: "c", frames: -20 }])).V1).toContain(
      "c 80–110 src 0",
    );
    expect(
      spans(applyEdits(cut, [{ kind: "slip", clipId: "a", frames: 20 }], { mediaSeconds })).V1,
    ).toContain("a 0–30 src 104");
    // A still has no media time to slip through.
    const still = linked(clip("a", 0, 30, "a.png"), clip("b", 200, 30), clip("c", 5, 30));
    expect(spans(applyEdits(still, [{ kind: "slip", clipId: "a", frames: 5 }]))).toEqual(
      spans(still),
    );
  });

  it("slides a clip between its neighbours, which trim to keep the cuts closed", () => {
    expect(spans(applyEdits(cut, [{ kind: "slide", clipId: "b", frames: -5 }]))).toMatchObject({
      V1: ["a 0–25 src 100", "b 25–55 src 200", "c 80–110 src 5"],
      A1: ["aA 0–25 src 100", "bA 25–55 src 200", "cA 80–110 src 5"],
    });
    // With a gap after it, b slides into the gap until it meets c; a grows to follow.
    expect(spans(applyEdits(cut, [{ kind: "slide", clipId: "b", frames: 40 }])).V1).toEqual([
      "a 0–50 src 100",
      "b 50–80 src 200",
      "c 80–110 src 5",
    ]);
    // a.mov has only 4 frames to give a's tail.
    expect(
      spans(applyEdits(cut, [{ kind: "slide", clipId: "b", frames: 40 }], { mediaSeconds })).V1,
    ).toEqual(["a 0–34 src 100", "b 34–64 src 200", "c 80–110 src 5"]);
    // Sliding left, the next clip's head grows from its handle: z has 2 frames.
    const row: Timeline = {
      ...timeline,
      tracks: {
        ...timeline.tracks,
        children: [track("V1", "Video", [clip("x", 100, 30), clip("y", 3, 30), clip("z", 2, 30)])],
      },
    };
    expect(spans(applyEdits(row, [{ kind: "slide", clipId: "y", frames: -5 }])).V1).toEqual([
      "x 0–28 src 100",
      "y 28–58 src 3",
      "z 58–90 src 0",
    ]);
  });

  it("links only sound playing the same media from the same frame", () => {
    expect(linkedTracks(cut, "b")).toEqual(["V1", "A1"]);
    const offset: Timeline = {
      ...cut,
      tracks: {
        ...cut.tracks,
        children: [
          track("V1", "Video", [clip("a", 100, 30)]),
          track("A1", "Audio", [clip("aA", 110, 30, "a.mov")]),
        ],
      },
    };
    expect(linkedTracks(offset, "a")).toEqual(["V1"]);
    expect(spans(applyEdits(offset, [{ kind: "slip", clipId: "a", frames: 5 }])).A1).toEqual([
      "aA 0–30 src 110",
    ]);
    // A razor through b and its sound leaves the other tracks whole.
    const razored = applyEdits(cut, [{ kind: "split", frame: 75, tracks: linkedTracks(cut, "n") }]);
    expect(spans(razored)).toMatchObject({
      V1: ["a 0–30 src 100", "b 30–60 src 200", "c 80–110 src 5"],
      A2: ["n 70–75 src 0", "n~75 75–100 src 5"],
    });
  });

  it("ripple deletes a clip with its sound, and a gap no other track plays in", () => {
    expect(rippleDeleteBlocked(cut, "b")).toBe(false);
    expect(spans(applyEdits(cut, [{ kind: "rippleDelete", clipId: "b" }]))).toEqual({
      V1: ["a 0–30 src 100", "c 50–80 src 5"],
      A1: ["aA 0–30 src 100", "cA 50–80 src 5"],
      A2: ["n 40–70 src 0"],
    });
    // V1's gap 60–80 is under n on A2, so closing it would cut n.
    expect(gapAt(cut, "V1", 65)).toEqual({ start: 60, end: 80, shared: true });
    expect(gapAt(cut, "V1", 45)).toBeNull();
    expect(gapAt(cut, "V1", 200)).toBeNull();
    const quiet: Timeline = {
      ...cut,
      tracks: { ...cut.tracks, children: cut.tracks.children.slice(0, 2) },
    };
    const found = gapAt(quiet, "V1", 65);
    expect(found).toEqual({ start: 60, end: 80, shared: false });
    expect(
      spans(applyEdits(quiet, [{ kind: "removeRange", start: 60, end: 80, ripple: true }])).V1,
    ).toEqual(["a 0–30 src 100", "b 30–60 src 200", "c 60–90 src 5"]);
  });
});

describe("insert and overwrite", () => {
  const known: Record<string, MediaFacts> = {
    "Footage/broll.mov": { seconds: 10, picture: true, sound: true },
    "Footage/mute.mov": { seconds: 10, picture: true, sound: false },
    "Audio/vo.wav": { seconds: 20, picture: false, sound: true },
    "Footage/photo.heic": { picture: true, sound: false },
  };
  const options = { media: (target: string) => known[target] };

  it("inserts on one track, cutting and moving later clips on every track", () => {
    const edited = applyEdits(
      timeline,
      [
        {
          kind: "insert",
          media: "Footage/mute.mov",
          startFrame: 15,
          sourceIn: 1,
          sourceOut: 2,
          videoTrack: "V1",
        },
      ],
      options,
    );
    expect(spans(edited)).toEqual({
      V2: ["c 10–15 src 50", "c~15 45–70 src 55"],
      V1: ["a 0–15 src 100", "V1@15 15–45 src 30", "a~15 45–60 src 115", "b 90–120 src 0"],
      A1: ["d 0–15 src 0", "d~15 45–60 src 15"],
    });
    // Only the tracks named move, and always the one it lands on.
    const held = applyEdits(
      timeline,
      [
        {
          kind: "insert",
          media: "Footage/mute.mov",
          startFrame: 15,
          frames: 30,
          videoTrack: "V1",
          rippleTracks: ["A1"],
        },
      ],
      options,
    );
    expect(spans(held)).toMatchObject({
      V2: ["c 10–40 src 50"],
      V1: ["a 0–15 src 100", "V1@15 15–45 src 0", "a~15 45–60 src 115", "b 90–120 src 0"],
      A1: ["d 0–15 src 0", "d~15 45–60 src 15"],
    });
  });

  it("overwrites what is there, moving nothing", () => {
    const edited = applyEdits(
      timeline,
      [
        {
          kind: "overwrite",
          media: "Footage/photo.heic",
          startFrame: 20,
          frames: 30,
          videoTrack: "V1",
          name: "Logo",
        },
      ],
      options,
    );
    expect(spans(edited)).toEqual({
      V2: ["c 10–40 src 50"],
      V1: ["a 0–20 src 100", "V1@20 20–50 src 0", "b 60–90 src 0"],
      A1: ["d 0–30 src 0"],
    });
    expect(layoutTimeline(edited).tracks[1]?.clips[1]?.clip.name).toBe("Logo");
  });

  it("places picture and sound as linked partners, on tracks it makes", () => {
    const edited = applyEdits(
      timeline,
      [
        {
          kind: "insert",
          media: "Footage/broll.mov",
          startFrame: 30,
          sourceIn: 2,
          sourceOut: 3,
          videoTrack: "V3",
          audioTrack: "A1",
        },
        {
          kind: "overwrite",
          media: "Audio/vo.wav",
          startFrame: 0,
          sourceIn: 4,
          sourceOut: 6,
          audioTrack: "A2",
        },
      ],
      options,
    );
    expect(edited.tracks.children.map((t) => `${t.name} ${t.kind}`)).toEqual([
      "V1 Video",
      "V2 Video",
      "V3 Video",
      "A1 Audio",
      "A2 Audio",
    ]);
    expect(spans(edited)).toEqual({
      V3: ["V3@30 30–60 src 60"],
      V2: ["c 10–30 src 50", "c~30 60–70 src 70"],
      V1: ["a 0–30 src 100", "b 90–120 src 0"],
      A1: ["d 0–30 src 0", "A1@30 30–60 src 60"],
      A2: ["A2@0 0–60 src 120"],
    });
    expect(linkedTracks(edited, "V3@30")).toEqual(["V3", "A1"]);
    // The pair moves together like any linked clip.
    expect(spans(applyEdits(edited, [{ kind: "slip", clipId: "A1@30", frames: 3 }]))).toMatchObject(
      { V3: ["V3@30 30–60 src 63"], A1: ["d 0–30 src 0", "A1@30 30–60 src 63"] },
    );
  });

  it("refuses media the project doesn't know, and ranges or tracks that don't fit it", () => {
    const at = { kind: "insert", startFrame: 0, videoTrack: "V1" } as const;
    expect(placementProblem(timeline, { ...at, media: "Footage/new.mov" }, options)).toBe(
      "Footage/new.mov isn't a media file this project knows",
    );
    expect(
      placementProblem(timeline, { ...at, media: "Footage/mute.mov", sourceOut: 12 }, options),
    ).toBe("sourceOut 12s is past the media's end (10s)");
    expect(
      placementProblem(
        timeline,
        { kind: "overwrite", media: "Audio/vo.wav", startFrame: 0, audioTrack: "V2" },
        options,
      ),
    ).toBe("V2 is a video track");
    expect(placementProblem(timeline, { ...at, media: "Audio/vo.wav" }, options)).toBe(
      "Audio/vo.wav has no picture",
    );
    expect(placementProblem(timeline, { ...at, media: "Footage/mute.mov" }, options)).toBeNull();
    // A refused placement changes nothing.
    expect(spans(applyEdits(timeline, [{ ...at, media: "Footage/new.mov" }], options))).toEqual(
      spans(timeline),
    );
  });
});
