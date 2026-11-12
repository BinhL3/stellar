import { describe, expect, it } from "vite-plus/test";

import { applyEdits, type TimelineEdit } from "../edits.ts";
import { layoutTimeline } from "../layout.ts";
import {
  type Clip,
  type Gap,
  rationalTime,
  type Timeline,
  TIMELINE_NAMESPACE,
  timeRange,
  type Track,
} from "../otio.ts";
import { linearTimeWarp } from "../speed.ts";
import { pushPlan, type PushStep, secondsAtFrame } from "./pushPlan.ts";

const clip = (
  id: string,
  sourceStart: number,
  frames: number,
  rate: number,
  url: string,
): Clip => ({
  OTIO_SCHEMA: "Clip.2",
  name: id,
  source_range: timeRange(sourceStart, frames, rate),
  media_references: {
    DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: url, metadata: {} },
  },
  active_media_reference_key: "DEFAULT_MEDIA",
  enabled: true,
  metadata: { premiere: { nodeId: id } },
});

const gap = (frames: number, rate: number): Gap => ({
  OTIO_SCHEMA: "Gap.1",
  name: "",
  source_range: timeRange(0, frames, rate),
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

const timelineOf = (tracks: ReadonlyArray<Track>, rate: number): Timeline => ({
  OTIO_SCHEMA: "Timeline.1",
  name: "t",
  global_start_time: rationalTime(0, rate),
  tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", enabled: true, metadata: {}, children: tracks },
  metadata: {},
});

// V1: v1 0–100, v2 100–200, v3 200–300, v4 300–400.  A1 the same as a1–a4.  V2: title 20–80.
const sequence = (rate: number) =>
  timelineOf(
    [
      track(
        "V1",
        "Video",
        ["v1", "v2", "v3", "v4"].map((id) => clip(id, 0, 100, rate, `${id}.mov`)),
      ),
      track("V2", "Video", [gap(20, rate), clip("title", 0, 60, rate, "title.png")]),
      track(
        "A1",
        "Audio",
        ["a1", "a2", "a3", "a4"].map((id) => clip(id, 0, 100, rate, `${id}.wav`)),
      ),
    ],
    rate,
  );
const base = sequence(30);
const edited = (...edits: ReadonlyArray<TimelineEdit>) => applyEdits(base, edits);
const lines = (ours: Timeline, from = base) => pushPlan(from, ours).text.split("\n");

/** What Premiere would hold after the steps, taking each at the position it states. */
const follow = (from: Timeline, steps: ReadonlyArray<PushStep>): Timeline =>
  steps.reduce((timeline, step) => {
    const clipAt = (wanted: { track: { name: string }; start: { frame: number } }) => {
      const trackIndex = timeline.tracks.children.findIndex((t) => t.name === wanted.track.name);
      let cursor = 0;
      for (const child of timeline.tracks.children[trackIndex]?.children ?? []) {
        const id = (child.metadata[TIMELINE_NAMESPACE] as { id?: string } | undefined)?.id;
        if (child.OTIO_SCHEMA === "Clip.2" && cursor === wanted.start.frame) {
          return id ?? (child.metadata["premiere"] as { nodeId: string }).nodeId;
        }
        cursor += child.source_range.duration.value;
      }
      throw new Error(`No clip on ${wanted.track.name} at frame ${wanted.start.frame}`);
    };
    switch (step.kind) {
      case "rippleRemove":
        return applyEdits(timeline, [
          { kind: "removeRange", start: step.start.frame, end: step.end.frame, ripple: true },
        ]);
      case "remove":
        return applyEdits(timeline, [{ kind: "delete", clipId: clipAt(step.clip) }]);
      case "trim":
        return applyEdits(timeline, [
          { kind: "trim", clipId: clipAt(step.clip), edge: step.edge, frame: step.to.frame },
        ]);
      case "move":
        return applyEdits(timeline, [
          {
            kind: "move",
            clipId: clipAt(step.clip),
            toTrack: step.toTrack.name,
            startFrame: step.toStart.frame,
          },
        ]);
      case "setEnabled":
        return applyEdits(timeline, [
          { kind: "setEnabled", clipId: clipAt(step.clip), enabled: step.enabled },
        ]);
      case "split":
        return applyEdits(timeline, [
          { kind: "split", frame: step.at.frame, tracks: [step.clip.track.name] },
        ]);
      // Marker steps touch no clip; the cut these checks follow is the same without them.
      case "addMarker":
      case "removeMarker":
      case "setMarker":
        return timeline;
    }
  }, from);

/** Each track's clips as `name start–end src on|off`: what Premiere would show, whatever the ids. */
const spans = (timeline: Timeline) =>
  Object.fromEntries(
    layoutTimeline(timeline).tracks.map((t) => [
      t.name,
      t.clips.map(
        (c) =>
          `${c.clip.name} ${c.startFrame}–${c.endFrame} src ${c.clip.source_range.start_time.value} ${c.clip.enabled ? "on" : "off"}`,
      ),
    ]),
  );

describe("pushPlan", () => {
  it("is empty when nothing differs", () => {
    expect(pushPlan(base, base)).toEqual({ rate: 30, steps: [], manual: [], text: "" });
  });

  it("orders ripple removes from the end, each at the position it has when it runs", () => {
    // Made here start-first, so the second range was named after the first had shifted it.
    const ours = edited(
      { kind: "removeRange", start: 100, end: 110, ripple: true },
      { kind: "removeRange", start: 240, end: 260, ripple: true },
    );
    expect(lines(ours)).toEqual([
      "1. ripple-remove 8.333333s-9.000s (frames 250-270) on V1,A1",
      "2. ripple-remove 3.333333s-3.666667s (frames 100-110) on V1,A1",
    ]);
    const plan = pushPlan(base, ours);
    expect(spans(follow(base, plan.steps))).toEqual(spans(ours));
  });

  it("cuts several ranges out of one clip without splitting it first", () => {
    const long = timelineOf(
      [
        track("V1", "Video", [clip("v", 0, 300, 30, "v.mov"), clip("w", 0, 100, 30, "w.mov")]),
        track("A1", "Audio", [clip("a", 0, 300, 30, "v.mov"), clip("b", 0, 100, 30, "w.mov")]),
      ],
      30,
    );
    const ours = applyEdits(long, [
      { kind: "removeRange", start: 40, end: 60, ripple: true },
      { kind: "removeRange", start: 180, end: 200, ripple: true },
    ]);
    expect(lines(ours, long)).toEqual([
      "1. ripple-remove 6.666667s-7.333333s (frames 200-220) on V1,A1",
      "2. ripple-remove 1.333333s-2.000s (frames 40-60) on V1,A1",
    ]);
    expect(spans(follow(long, pushPlan(long, ours).steps))).toEqual(spans(ours));
  });

  it("trims an edge, naming the clip where it is and the source point to set", () => {
    const ours = edited(
      { kind: "trim", clipId: "v4", edge: "end", frame: 380 },
      { kind: "trim", clipId: "a1", edge: "start", frame: 10 },
    );
    expect(lines(ours)).toEqual([
      '1. trim end of "v4" on V1 at 10.000s: 13.333333s → 12.666667s (frames 400 → 380; source out 2.666667s)',
      '2. trim start of "a1" on A1 at 0.000s: 0.000s → 0.333333s (frames 0 → 10; source in 0.333333s)',
    ]);
    expect(spans(follow(base, pushPlan(base, ours).steps))).toEqual(spans(ours));
  });

  it("names a sped-up clip's source point by its speed, and leaves a reversed clip's trim to a person", () => {
    const warped = (speed: number, frames = 100) =>
      timelineOf(
        [
          track("V1", "Video", [
            { ...clip("v1", 30, frames, 30, "v1.mov"), effects: [linearTimeWarp(speed)] },
          ]),
        ],
        30,
      );
    const trim: TimelineEdit = { kind: "trim", clipId: "v1", edge: "end", frame: 80 };
    // 80 frames at double speed end 160 source frames after the in point at 1 s.
    expect(lines(applyEdits(warped(2), [trim]), warped(2))).toEqual([
      '1. trim end of "v1" on V1 at 0.000s: 3.333333s → 2.666667s (frames 100 → 80; source out 6.333333s)',
    ]);
    const reversed = pushPlan(warped(-1), applyEdits(warped(-1), [trim]));
    expect(reversed.steps).toEqual([]);
    expect(reversed.manual).toEqual(["Trimmed v1 on V1 at 0:00: cut 0.7s off its end"]);
  });

  it("leaves captions out of every step, as Premiere has no track number for them", () => {
    const captioned = (words: string) =>
      timelineOf(
        [
          track("V1", "Video", [clip("v1", 0, 100, 30, "v1.mov")]),
          {
            ...track("C1", "Video", [
              {
                ...clip("c1", 0, 100, 30, ""),
                metadata: { premiere: { nodeId: "c1" }, [TIMELINE_NAMESPACE]: { text: words } },
              },
            ]),
            metadata: { [TIMELINE_NAMESPACE]: { captions: true } },
          },
          track("V2", "Video", [clip("v2", 0, 100, 30, "v2.mov")]),
        ],
        30,
      );
    const from = captioned("Hello");
    const ours = applyEdits(from, [
      { kind: "setEnabled", clipId: "v2", enabled: false },
      { kind: "delete", clipId: "c1" },
    ]);
    const plan = pushPlan(from, ours);
    // V2 keeps its number although the caption track sits between it and V1 here.
    expect(plan.steps).toMatchObject([
      { kind: "setEnabled", clip: { track: { kind: "video", index: 2, name: "V2" } } },
    ]);
    expect(plan.manual).toEqual(["Removed c1 from C1 at 0:00"]);
  });

  it("moves a clip across tracks and in time", () => {
    const ours = edited({ kind: "move", clipId: "title", toTrack: "V1", startFrame: 500 });
    const plan = pushPlan(base, ours);
    expect(plan.steps).toEqual([
      {
        kind: "move",
        clip: {
          name: "title",
          track: { kind: "video", index: 2, name: "V2" },
          start: { frame: 20, seconds: 0.666667 },
          end: { frame: 80, seconds: 2.666667 },
        },
        toTrack: { kind: "video", index: 1, name: "V1" },
        toStart: { frame: 500, seconds: 16.666667 },
      },
    ]);
    expect(plan.text).toBe(
      '1. move "title" on V2 at 0.666667s → V1 at 16.666667s (frames 20 → 500)',
    );
  });

  it("removes, disables and splits, after the ripples and at the positions they leave", () => {
    const ours = edited(
      { kind: "delete", clipId: "title" },
      { kind: "setEnabled", clipId: "a4", enabled: false },
      { kind: "split", frame: 350, tracks: ["V1"] },
      { kind: "setEnabled", clipId: "v4~350", enabled: false },
      { kind: "removeRange", start: 100, end: 200, ripple: true },
    );
    expect(lines(ours)).toEqual([
      "1. ripple-remove 3.333333s-6.666667s (frames 100-200) on V1,A1",
      '2. split "v4" on V1 at 6.666667s: cut at 8.333333s (frame 250)',
      '3. remove "title" on V2 at 0.666667s-2.666667s (frames 20-80), leaving its gap open',
      '4. disable "v4" on V1 at 8.333333s (frame 250)',
      '5. disable "a4" on A1 at 6.666667s (frame 200)',
    ]);
    expect(spans(follow(base, pushPlan(base, ours).steps))).toEqual(spans(ours));
  });

  it("holds the tracks a ripple did not shift", () => {
    // v2 is gone and V1 closed up; A1 still plays a2 there.
    const plan = pushPlan(
      base,
      timelineOf(
        [
          track("V1", "Video", [
            clip("v1", 0, 100, 30, "v1.mov"),
            clip("v3", 0, 100, 30, "v3.mov"),
            clip("v4", 0, 100, 30, "v4.mov"),
          ]),
          base.tracks.children[1]!,
          base.tracks.children[2]!,
        ],
        30,
      ),
    );
    expect(plan.text).toBe(
      "1. ripple-remove 3.333333s-6.666667s (frames 100-200) on V1; keep A1 in place (lock first)",
    );
  });

  it("lists what no step does: added clips, properties, tracks", () => {
    const fresh = clip("broll", 30, 50, 30, "broll.mov");
    const ours: Timeline = {
      ...base,
      tracks: {
        ...base.tracks,
        children: [
          ...base.tracks.children.map((item) =>
            item.name !== "V2"
              ? item
              : {
                  ...item,
                  children: [
                    ...item.children.map((child) =>
                      child.OTIO_SCHEMA === "Clip.2"
                        ? {
                            ...child,
                            metadata: { ...child.metadata, [TIMELINE_NAMESPACE]: { text: "Hi" } },
                          }
                        : child,
                    ),
                    gap(20, 30),
                    fresh,
                  ],
                },
          ),
          track("A2", "Audio", []),
        ],
      },
    };
    const plan = pushPlan(base, ours);
    expect(plan.steps).toEqual([]);
    expect(plan.manual).toEqual([
      "Added track A2",
      "Changed text of title on V2 at 0:00",
      "Add broll to V2 at 3.333333s-5.000s (frames 100-150, source in 1.000s of broll.mov); import its media first if the project lacks it",
    ]);
    expect(plan.text.split("\n")[0]).toBe("By hand, no step here does it safely:");
  });

  it("adds marker steps after the cut, each marker at the place it ends up", () => {
    // Premiere's save has a user's note at 250 and a chapter mark; here the note is answered
    // and resolved, the chapter mark removed, and two markers made, one on v3's picture.
    const pulled = applyEdits(base, [
      {
        kind: "addMarker",
        markerId: "m1",
        frame: 250,
        name: "Cut too early",
        note: "lose two frames",
      },
      { kind: "addMarker", markerId: "m2", frame: 20, name: "Chapter", color: "BLUE" },
    ]);
    const ours = applyEdits(pulled, [
      { kind: "removeRange", start: 100, end: 110, ripple: true },
      { kind: "setMarker", markerId: "m1", resolved: true, color: "RED" },
      { kind: "removeMarker", markerId: "m2" },
      { kind: "addMarker", frame: 300, duration: 30, name: "B-roll here", author: "agent" },
      { kind: "addMarker", frame: 200, clipId: "v3", name: "Smile" },
    ]);
    const plan = pushPlan(pulled, ours);
    expect(plan.text.split("\n")).toEqual([
      "1. ripple-remove 3.333333s-3.666667s (frames 100-110) on V1,A1",
      '2. remove sequence marker "Chapter" at 0.666667s (frame 20)',
      // The cut moved it from 250 to 240; the step names where Premiere's save has it.
      '3. change sequence marker "Cut too early" at 8.333333s (frame 250): move to 8.000s (frame 240), comment "lose two frames\\n[stellar: resolved]", colour red (index 1)',
      '4. add sequence marker "B-roll here" at 10.000s (frame 300), 1.000s long, colour green (index 0), comment "[stellar: agent]"',
      '5. add clip marker "Smile" at source 0.333333s of v3.mov, colour green (index 0), comment ""',
    ]);
    expect(plan.manual).toEqual([]);
    // Only markers differ: no cut steps, and nothing left for a person.
    expect(
      pushPlan(pulled, applyEdits(pulled, [{ kind: "removeMarker", markerId: "m2" }])).steps,
    ).toMatchObject([{ kind: "removeMarker", marker: { name: "Chapter", colorIndex: 6 } }]);
  });

  it("gives seconds for 59.94 fps as frames of 1001/60000 s", () => {
    const rate = 59.94005994005994;
    expect(secondsAtFrame(740, rate)).toBe(12.345667);
    expect(secondsAtFrame(60000, rate)).toBe(1001);
    expect(secondsAtFrame(24, 23.976)).toBe(1.001);
    expect(secondsAtFrame(25, 12.5)).toBe(2);
    const ntsc = sequence(rate);
    const ours = applyEdits(ntsc, [{ kind: "removeRange", start: 100, end: 160, ripple: true }]);
    expect(pushPlan(ntsc, ours).text).toBe(
      "1. ripple-remove 1.668333s-2.669333s (frames 100-160) on V1,A1",
    );
  });
});
