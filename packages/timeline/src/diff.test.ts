import { describe, expect, it } from "vite-plus/test";

import { checkTimeline, diffSentences, diffText, diffTimelines, mergeTimelines } from "./diff.ts";
import { applyEdits, type TimelineEdit } from "./edits.ts";
import { layoutTimeline } from "./layout.ts";
import {
  type Clip,
  type Gap,
  rationalTime,
  type Timeline,
  TIMELINE_NAMESPACE,
  timeRange,
  type Track,
} from "./otio.ts";
import { linearTimeWarp } from "./speed.ts";

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

const timelineOf = (tracks: ReadonlyArray<Track>): Timeline => ({
  OTIO_SCHEMA: "Timeline.1",
  name: "t",
  global_start_time: rationalTime(0, RATE),
  tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", enabled: true, metadata: {}, children: tracks },
  metadata: {},
});

// V1: v1 0–100, v2 100–200, v3 200–300, v4 300–400.  A1 the same as a1–a4.  V2: title 20–80.
const base = timelineOf([
  track("V1", "Video", [
    clip("v1", 0, 100),
    clip("v2", 0, 100),
    clip("v3", 0, 100),
    clip("v4", 0, 100),
  ]),
  track("V2", "Video", [gap(20), clip("title", 0, 60, "title.png")]),
  track("A1", "Audio", [
    clip("a1", 0, 100, "a1.wav"),
    clip("a2", 0, 100, "a2.wav"),
    clip("a3", 0, 100, "a3.wav"),
    clip("a4", 0, 100, "a4.wav"),
  ]),
]);

const edited = (...edits: ReadonlyArray<TimelineEdit>) => applyEdits(base, edits);
const lines = (from: Timeline, to: Timeline) => diffText(diffTimelines(from, to)).split("\n");

/** Lines without clip ids, to compare versions whose ids differ. */
const plain = (text: ReadonlyArray<string>) => text.map((line) => line.replace(/#\S+ /, ""));

const mapClips = (timeline: Timeline, change: (clip: Clip) => Clip): Timeline => ({
  ...timeline,
  tracks: {
    ...timeline.tracks,
    children: timeline.tracks.children.map((item) => ({
      ...item,
      children: item.children.map((child) =>
        child.OTIO_SCHEMA === "Clip.2" ? change(child) : child,
      ),
    })),
  },
});

const scaled = (timeline: Timeline, name: string, scale: number) =>
  mapClips(timeline, (item) =>
    item.name === name
      ? { ...item, metadata: { ...item.metadata, [TIMELINE_NAMESPACE]: { transform: { scale } } } }
      : item,
  );

/** As Premiere would save it if it handed out new track item ids: no ids of ours, fresh nodeIds. */
const repulled = (timeline: Timeline) => {
  let next = 0;
  return mapClips(timeline, (item) => ({
    ...item,
    metadata: {
      [TIMELINE_NAMESPACE]: { ...(item.metadata[TIMELINE_NAMESPACE] as object), id: undefined },
      premiere: { ...(item.metadata["premiere"] as object), nodeId: `n${next++}` },
    },
  }));
};

/** Each track as `name start–end src` for the clips on it. */
const spans = (timeline: Timeline) =>
  Object.fromEntries(
    layoutTimeline(timeline).tracks.map((t) => [
      t.name,
      t.clips.map(
        (c) =>
          `${c.clip.name} ${c.startFrame}–${c.endFrame} src ${c.clip.source_range.start_time.value}`,
      ),
    ]),
  );

describe("diffTimelines", () => {
  it("is empty for the same timeline, with or without ids", () => {
    expect(diffTimelines(base, base).changes).toEqual([]);
    expect(diffText(diffTimelines(base, repulled(base)))).toBe("");
    expect(diffTimelines(edited({ kind: "delete", clipId: "nope" }), base).changes).toEqual([]);
  });

  it("reports removed, added, trimmed, moved and changed clips", () => {
    const next = scaled(
      edited(
        { kind: "delete", clipId: "v2" },
        { kind: "trim", clipId: "v4", edge: "end", frame: 380 },
        { kind: "trim", clipId: "a1", edge: "start", frame: 10 },
        { kind: "move", clipId: "title", toTrack: "V2", startFrame: 200 },
        { kind: "setEnabled", clipId: "a3", enabled: false },
      ),
      "v1",
      120,
    );
    expect(lines(base, next)).toEqual([
      "changed V1 0-100 #v1 v1: scale",
      "trimmed A1 #a1 start 0→10 a1",
      "moved V2 20-80 → V2 200-260 #title title",
      "removed V1 100-200 #v2 v2",
      "changed A1 200-300 #a3 a3: enabled",
      "trimmed V1 #v4 end 400→380 v4",
    ]);
    expect(lines(next, base)).toContain("added V1 100-200 #v2 v2");
    expect(diffSentences(diffTimelines(base, next))).toEqual([
      "Changed scale of v1 on V1 at 0:00",
      "Trimmed a1 on A1 at 0:00: cut 0.3s off its start",
      "Moved title on V2 from 0:00 to 0:06",
      "Removed v2 from V1 at 0:03",
      "Changed enabled of a3 on A1 at 0:06",
      "Trimmed v4 on V1 at 0:10: cut 0.7s off its end",
    ]);
  });

  it("reports a ripple as one change, however many clips follow it", () => {
    const next = edited({ kind: "removeRange", start: 100, end: 200, ripple: true });
    expect(lines(base, next)).toEqual([
      "removed V1 100-200 #v2 v2",
      "removed A1 100-200 #a2 a2",
      "rippled V1,A1 from 200 by -100 (4 clips)",
    ]);
    expect(diffSentences(diffTimelines(base, next)).at(-1)).toBe(
      "Moved 4 clips on V1 and A1 3.3s earlier, from 0:06 on",
    );
  });

  it("separates a cut inside a clip, and several cuts, into their own ripples", () => {
    const next = edited(
      { kind: "removeRange", start: 250, end: 270, ripple: true },
      { kind: "removeRange", start: 100, end: 110, ripple: true },
    );
    expect(lines(base, next)).toEqual([
      "trimmed V1 #v2 start 100→110 v2",
      "trimmed A1 #a2 start 100→110 a2",
      "rippled V1,A1 from 110 by -10 (6 clips)",
      "trimmed V1 #v3 end 300→250 v3",
      "trimmed A1 #a3 end 300→250 a3",
      "added V1 240-270 #v3~270 v3",
      "added A1 240-270 #a3~270 a3",
      "rippled V1,A1 from 300 by -20 (2 clips)",
    ]);
  });

  it("tells a clip that moved alone from the ripple around it", () => {
    const next = edited(
      { kind: "delete", clipId: "title" },
      { kind: "move", clipId: "v4", toTrack: "V1", startFrame: 500 },
    );
    expect(lines(base, next)).toEqual([
      "removed V2 20-80 #title title",
      "moved V1 300-400 → V1 500-600 #v4 v4",
    ]);
  });

  it("does not take a piece cut off one clip for a removed clip of the same media", () => {
    const takes = timelineOf([
      track("V1", "Video", [clip("x", 0, 100, "take.mov"), clip("y", 90, 100, "take.mov")]),
    ]);
    const next = applyEdits(takes, [
      { kind: "delete", clipId: "x" },
      { kind: "split", frame: 150 },
    ]);
    expect(lines(takes, next)).toEqual([
      "removed V1 0-100 #x x",
      "trimmed V1 #y end 200→150 y",
      "added V1 150-200 #y~150 y",
    ]);
  });

  it("matches clips by media and source when Premiere hands out new ids", () => {
    const next = repulled(
      edited(
        { kind: "delete", clipId: "title" },
        { kind: "removeRange", start: 100, end: 200, ripple: true },
        { kind: "trim", clipId: "v4", edge: "end", frame: 280 },
      ),
    );
    expect(lines(base, next)).toEqual([
      "removed V2 20-80 #title title",
      "removed V1 100-200 #v2 v2",
      "removed A1 100-200 #a2 a2",
      "rippled V1,A1 from 200 by -100 (4 clips)",
      "trimmed V1 #n2 end 400→380 v4",
    ]);
  });

  it("reports tracks added, removed, renamed and changed", () => {
    const [v1, v2, a1] = base.tracks.children as [Track, Track, Track];
    const next = timelineOf([
      { ...v1, metadata: { premiere: { transitions: [{ name: "Cross Dissolve" }] } } },
      { ...v2, name: "V3" },
      track("A2", "Audio", []),
    ]);
    expect(lines(base, next)).toEqual([
      "track renamed V2 → V3",
      "track added A2",
      "track removed A1",
      "track changed V1: transitions",
      "removed A1 0-100 #a1 a1",
      "removed A1 100-200 #a2 a2",
      "removed A1 200-300 #a3 a3",
      "removed A1 300-400 #a4 a4",
    ]);
    expect(a1.name).toBe("A1");
  });
});

describe("speed changes", () => {
  const one = (speed?: number) =>
    timelineOf([
      track("V1", "Video", [
        speed === undefined
          ? clip("v1", 0, 100)
          : { ...clip("v1", 0, 100), effects: [linearTimeWarp(speed)] },
      ]),
    ]);

  it("reports a new speed as a change, not a trim", () => {
    expect(diffTimelines(one(), one(2)).changes).toMatchObject([
      { kind: "changed", properties: ["speed"] },
    ]);
    expect(diffTimelines(one(2), one(2)).changes).toEqual([]);
  });

  it("reads a trim of a sped-up or reversed clip in timeline frames", () => {
    for (const speed of [2, -1]) {
      const trimmed = applyEdits(one(speed), [
        { kind: "trim", clipId: "v1", edge: "start", frame: 20 },
      ]);
      expect(diffTimelines(one(speed), trimmed).changes).toMatchObject([
        { kind: "trimmed", start: { before: 0, after: 20 } },
      ]);
    }
  });

  it("measures the media a sped-up clip uses against the file's length", () => {
    // 100 frames at double speed play 200 source frames: 6.67 s of a 5 s file.
    expect(checkTimeline(one(2), { "v1.mov": { duration: 5 } })).toMatchObject([
      { kind: "source", message: "V1 v1 at frame 0 runs 1.67s past the end of its media." },
    ]);
    expect(checkTimeline(one(2), { "v1.mov": { duration: 7 } })).toEqual([]);
  });
});

describe("checkTimeline", () => {
  it("passes a sound timeline and every edit of it", () => {
    expect(checkTimeline(base)).toEqual([]);
    expect(
      checkTimeline(edited({ kind: "removeRange", start: 50, end: 250, ripple: true })),
    ).toEqual([]);
  });

  it("names overlaps, misplaced clips, empty clips and source past the media", () => {
    const at = (item: Clip, startFrame: number, endFrame: number): Clip => ({
      ...item,
      metadata: { premiere: { nodeId: item.name, record: { startFrame, endFrame } } },
    });
    const broken = timelineOf([
      track("V1", "Video", [
        at(clip("v1", 0, 100), 0, 100),
        at(clip("v2", 0, 100), 60, 160),
        at(clip("v3", 0, 100), 20, 120),
        at(clip("v4", 0, 100), 400, 500),
      ]),
      track("V2", "Video", [gap(400), clip("v5", 950, 0), clip("v6", 950, 100)]),
    ]);
    expect(checkTimeline(broken, { "v6.mov": { duration: 34 } })).toMatchObject([
      { kind: "overlap", clipId: "v2", message: "V1 v2 at frame 100 overlaps the previous item." },
      { kind: "order", clipId: "v3" },
      {
        kind: "position",
        message: "V1 v4 at frame 300 is recorded at frames 400-500 but plays at 300-400.",
      },
      { kind: "duration", message: "V2 v5 at frame 400 has no length." },
      { kind: "source", message: "V2 v6 at frame 400 runs 1.00s past the end of its media." },
    ]);
  });
});

describe("mergeTimelines", () => {
  const ourCut: TimelineEdit = { kind: "removeRange", start: 100, end: 200, ripple: true };

  it("is our edit when only we changed, and theirs when only they did", () => {
    const ours = edited(ourCut);
    const onlyOurs = mergeTimelines(base, ours, repulled(base));
    expect(onlyOurs.conflicts).toEqual([]);
    expect(spans(onlyOurs.timeline)).toEqual(spans(ours));

    const theirs = repulled(edited({ kind: "trim", clipId: "v4", edge: "end", frame: 380 }));
    expect(mergeTimelines(base, base, theirs)).toEqual({ timeline: theirs, conflicts: [] });
  });

  it("keeps both sides' changes to different clips, and everything Premiere-only", () => {
    const ours = edited(
      { kind: "trim", clipId: "v1", edge: "end", frame: 90 },
      { kind: "setEnabled", clipId: "a3", enabled: false },
      { kind: "move", clipId: "title", toTrack: "V2", startFrame: 300 },
    );
    const theirsEdited = scaled(
      edited({ kind: "trim", clipId: "v4", edge: "start", frame: 320 }),
      "v2",
      120,
    );
    const transitions = { premiere: { transitions: [{ name: "Cross Dissolve" }] } };
    const theirs = repulled({
      ...theirsEdited,
      metadata: { premiere: { sequenceId: "s1" } },
      tracks: {
        ...theirsEdited.tracks,
        children: theirsEdited.tracks.children.map((item) =>
          item.name === "V1" ? { ...item, metadata: transitions } : item,
        ),
      },
    });
    const merge = mergeTimelines(base, ours, theirs);
    expect(merge.conflicts).toEqual([]);
    expect(merge.timeline.metadata).toEqual({ premiere: { sequenceId: "s1" } });
    expect(merge.timeline.tracks.children[0]?.metadata).toEqual(transitions);
    expect(checkTimeline(merge.timeline)).toEqual([]);
    expect(lines(base, merge.timeline)).toEqual([
      "track changed V1: transitions",
      "trimmed V1 #n0 end 100→90 v1",
      "moved V2 20-80 → V2 300-360 #n4 title",
      "changed V1 100-200 #n1 v2: scale",
      "changed A1 200-300 #n7 a3: enabled",
      "trimmed V1 #n3 start 300→320 v4",
    ]);
    // What we changed in theirs is exactly what we changed in the base.
    expect(plain(lines(theirs, merge.timeline))).toEqual(plain(lines(base, ours)));
  });

  it("keeps their version of a clip both changed, and says so", () => {
    const ours = scaled(
      edited(
        { kind: "trim", clipId: "v4", edge: "end", frame: 350 },
        { kind: "delete", clipId: "v2" },
      ),
      "v1",
      150,
    );
    const theirs = scaled(
      scaled(edited({ kind: "trim", clipId: "v4", edge: "end", frame: 380 }), "v2", 120),
      "v1",
      110,
    );
    const merge = mergeTimelines(base, ours, theirs);
    expect(spans(merge.timeline)).toEqual(spans(theirs));
    expect(lines(theirs, merge.timeline)).toEqual([""]);
    expect(merge.conflicts.map((conflict) => conflict.message)).toEqual([
      "v1 on V1 at 0:00 had its scale changed on both sides; Premiere's version was kept.",
      "v2 on V1 at 0:03 was changed in Premiere, so it was not removed.",
      "v4 on V1 at 0:10 had its end trimmed on both sides; Premiere's trim was kept.",
    ]);
    expect(merge.conflicts.map((conflict) => conflict.change.kind)).toEqual([
      "changed",
      "removed",
      "trimmed",
    ]);
  });

  it("ripples the clip they trimmed downstream of our cut", () => {
    const ours = edited(ourCut);
    const theirs = repulled(
      edited(
        { kind: "trim", clipId: "v4", edge: "end", frame: 380 },
        { kind: "trim", clipId: "a4", edge: "end", frame: 380 },
      ),
    );
    const merge = mergeTimelines(base, ours, theirs);
    expect(merge.conflicts).toEqual([]);
    expect(spans(merge.timeline)).toEqual({
      V2: ["title 20–80 src 0"],
      V1: ["v1 0–100 src 0", "v3 100–200 src 0", "v4 200–280 src 0"],
      A1: ["a1 0–100 src 0", "a3 100–200 src 0", "a4 200–280 src 0"],
    });
    expect(plain(lines(base, merge.timeline))).toEqual(
      expect.arrayContaining(plain(lines(base, theirs))),
    );
  });

  it("composes our ripple with theirs, whichever is upstream", () => {
    const early: TimelineEdit = { kind: "removeRange", start: 30, end: 50, ripple: false };
    const cutV3: TimelineEdit = { kind: "removeRange", start: 200, end: 300, ripple: true };
    for (const [mine, theirEdit] of [
      [ourCut, cutV3],
      [cutV3, ourCut],
    ] as const) {
      const merge = mergeTimelines(base, edited(mine), repulled(edited(early, theirEdit)));
      expect(merge.conflicts).toEqual([]);
      expect(spans(merge.timeline)).toMatchObject({
        V1: ["v1 0–30 src 0", "v1 50–100 src 50", "v4 100–200 src 0"],
        A1: ["a1 0–30 src 0", "a1 50–100 src 50", "a4 100–200 src 0"],
      });
    }
  });

  it("cuts inside a clip they put an effect on, keeping the effect on both pieces", () => {
    const ours = edited(
      { kind: "removeRange", start: 240, end: 260, ripple: true },
      { kind: "setEnabled", clipId: "v3", enabled: false },
    );
    const theirs = repulled(scaled(base, "v3", 120));
    const merge = mergeTimelines(base, ours, theirs);
    expect(merge.conflicts).toEqual([]);
    expect(spans(merge.timeline)).toMatchObject({
      V1: [
        "v1 0–100 src 0",
        "v2 100–200 src 0",
        "v3 200–240 src 0",
        "v3 240–280 src 60",
        "v4 280–380 src 0",
      ],
    });
    const pieces = layoutTimeline(merge.timeline)
      .tracks.flatMap((t) => t.clips)
      .filter((item) => item.clip.name === "v3");
    expect(pieces.map((item) => item.clip.metadata[TIMELINE_NAMESPACE])).toMatchObject([
      { transform: { scale: 120 } },
      { transform: { scale: 120 } },
    ]);
    expect(pieces.map((item) => item.clip.enabled)).toEqual([false, true]);
  });

  it("drops a ripple that would cut a clip they added, and lists it", () => {
    const ours = edited(ourCut);
    const [v1, v2, a1] = base.tracks.children as [Track, Track, Track];
    const theirs = timelineOf([
      v1,
      { ...v2, children: [...v2.children, gap(60), clip("broll", 0, 40)] },
      a1,
    ]);
    const merge = mergeTimelines(base, ours, theirs);
    expect(merge.conflicts.map((conflict) => conflict.message)).toEqual([
      "Premiere's version has clips in the way, so the clips from 0:06 on were not moved 3.3s earlier.",
    ]);
    expect(checkTimeline(merge.timeline)).toEqual([]);
    expect(spans(merge.timeline)).toMatchObject({
      V2: ["title 20–80 src 0", "broll 140–180 src 0"],
      V1: ["v1 0–100 src 0", "v3 200–300 src 0", "v4 300–400 src 0"],
    });
  });

  it("applies once what both sides did alike", () => {
    const ours = edited(ourCut, { kind: "setEnabled", clipId: "v1", enabled: false });
    const theirs = repulled(edited(ourCut));
    const merge = mergeTimelines(base, ours, theirs);
    expect(merge.conflicts).toEqual([]);
    expect(spans(merge.timeline)).toEqual(spans(ours));
    expect(lines(theirs, merge.timeline)).toEqual(["changed V1 0-100 #n0 v1: enabled"]);
  });
});

describe("keyframes through a head trim", () => {
  // v3 slides in over its first second: Motion scale and a Transform effect's position.
  const animate = (timeline: Timeline, scaleTo = 120) =>
    mapClips(timeline, (item) =>
      item.name === "v3"
        ? {
            ...item,
            metadata: {
              ...item.metadata,
              [TIMELINE_NAMESPACE]: {
                ...(item.metadata[TIMELINE_NAMESPACE] as object),
                transform: {
                  keyframes: {
                    scale: [
                      [0, 100],
                      [1, scaleTo],
                    ],
                  },
                },
                effects: [
                  {
                    kind: "Transform",
                    ref: "sha256:t",
                    bypassed: true,
                    params: {
                      rotation: 5,
                      keyframes: {
                        position: [
                          [0, [0.5, -1.4]],
                          [1, [0.5, 0.5]],
                        ],
                      },
                    },
                  },
                ],
              },
            },
          }
        : item,
    );
  const animated = animate(base);
  const headTrim: TimelineEdit = { kind: "trim", clipId: "v3", edge: "start", frame: 215 };
  /** Each piece of v3 with the times of its scale and position keyframes. */
  const keys = (timeline: Timeline) =>
    layoutTimeline(timeline)
      .tracks.flatMap((t) => t.clips)
      .filter((item) => item.clip.name === "v3")
      .map((item) => {
        const stellar = item.clip.metadata[TIMELINE_NAMESPACE] as {
          transform: { keyframes: { scale: ReadonlyArray<ReadonlyArray<number>> } };
          effects: ReadonlyArray<{
            ref: string;
            bypassed: boolean;
            params: {
              rotation: number;
              keyframes: { position: ReadonlyArray<ReadonlyArray<unknown>> };
            };
          }>;
        };
        // What the effect is besides its timing reaches every version as it was read.
        expect(
          stellar.effects.map(({ ref, bypassed, params }) => [ref, bypassed, params.rotation]),
        ).toEqual([["sha256:t", true, 5]]);
        return {
          at: item.startFrame,
          scale: stellar.transform.keyframes.scale.map(([at, value]) => `${at}:${value}`),
          position: stellar.effects.map((effect) =>
            effect.params.keyframes.position.map(([at]) => at),
          ),
        };
      });

  it("reports the trim alone, however many steps it took, and a real change beside it", () => {
    const trimmed = applyEdits(animated, [headTrim]);
    expect(lines(animated, trimmed)).toEqual(["trimmed V1 #v3 start 200→215 v3"]);
    expect(diffSentences(diffTimelines(animated, trimmed))).toEqual([
      "Trimmed v3 on V1 at 0:06: cut 0.5s off its start",
    ]);
    // Frame by frame, where each step rounds the times again.
    const nudged = applyEdits(
      animated,
      [201, 202, 203].map((frame): TimelineEdit => ({ ...headTrim, frame })),
    );
    expect(lines(animated, nudged)).toEqual(["trimmed V1 #v3 start 200→203 v3"]);
    // A keyframe that really changed is still a change, trimmed or not.
    expect(lines(animated, applyEdits(animate(base, 150), [headTrim]))).toEqual([
      "trimmed V1 #v3 start 200→215 v3",
      "changed V1 215-300 #v3 v3: scale keyframes",
    ]);
  });

  it("merges our head trim onto their copy with the keyframes moved once", () => {
    const ours = applyEdits(animated, [headTrim]);
    const moved = { at: 215, scale: ["-0.5:100", "0.5:120"], position: [[-0.5, 0.5]] };
    expect(keys(ours)).toEqual([moved]);

    const untouched = mergeTimelines(animated, ours, repulled(animated));
    expect(untouched.conflicts).toEqual([]);
    expect(keys(untouched.timeline)).toEqual([moved]);

    // They changed the animation's end value; our trim keeps their curve on its frames.
    const theirs = mergeTimelines(animated, ours, repulled(animate(base, 150)));
    expect(theirs.conflicts).toEqual([]);
    expect(keys(theirs.timeline)).toEqual([{ ...moved, scale: ["-0.5:100", "0.5:150"] }]);

    // We changed it and trimmed; they did neither.
    const both = mergeTimelines(
      animated,
      applyEdits(animate(base, 150), [headTrim]),
      repulled(animated),
    );
    expect(both.conflicts).toEqual([]);
    expect(keys(both.timeline)).toEqual([{ ...moved, scale: ["-0.5:100", "0.5:150"] }]);

    // An edit elsewhere (as a restored version's may be) leaves their clip as they saved it.
    const theirSave = repulled(animate(base, 150));
    const elsewhere = mergeTimelines(
      animated,
      applyEdits(animated, [{ kind: "setEnabled", clipId: "v1", enabled: false }]),
      theirSave,
    );
    expect(elsewhere.conflicts).toEqual([]);
    const v3 = (timeline: Timeline) =>
      timeline.tracks.children[0]?.children[2]?.metadata[TIMELINE_NAMESPACE];
    expect(v3(elsewhere.timeline)).toEqual(v3(theirSave));
  });

  it("cuts a clip whose animation they changed, each piece keeping their curve in step", () => {
    const ours = applyEdits(animated, [{ kind: "split", frame: 215, tracks: ["V1"] }]);
    const merge = mergeTimelines(animated, ours, repulled(animate(base, 150)));
    expect(merge.conflicts).toEqual([]);
    expect(keys(merge.timeline)).toEqual([
      { at: 200, scale: ["0:100", "1:150"], position: [[0, 1]] },
      { at: 215, scale: ["-0.5:100", "0.5:150"], position: [[-0.5, 0.5]] },
    ]);
  });
});
