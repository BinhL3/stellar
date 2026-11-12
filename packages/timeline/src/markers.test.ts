import { describe, expect, it } from "vite-plus/test";

import { diffSentences, diffText, diffTimelines, mergeTimelines } from "./diff.ts";
import { applyEdits, type TimelineEdit } from "./edits.ts";
import {
  markersText,
  parsePremiereMarkerComment,
  premiereMarkerComment,
  timelineMarkers,
} from "./markers.ts";
import {
  type Clip,
  type Marker,
  rationalTime,
  type Timeline,
  TIMELINE_NAMESPACE,
  timeRange,
  type Track,
} from "./otio.ts";

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

const track = (name: string, kind: Track["kind"], children: Track["children"]): Track => ({
  OTIO_SCHEMA: "Track.1",
  name,
  kind,
  children,
  enabled: true,
  metadata: {},
});

// V1: v1 0–100, v2 100–200, v3 200–300.  A1: a1 0–300.
const base: Timeline = {
  OTIO_SCHEMA: "Timeline.1",
  name: "t",
  global_start_time: rationalTime(0, RATE),
  tracks: {
    OTIO_SCHEMA: "Stack.1",
    name: "tracks",
    enabled: true,
    metadata: {},
    children: [
      track("V1", "Video", [clip("v1", 0, 100), clip("v2", 500, 100), clip("v3", 0, 100)]),
      track("A1", "Audio", [clip("a1", 0, 300, "a1.wav")]),
    ],
  },
  metadata: {},
};

const edited = (from: Timeline, ...edits: ReadonlyArray<TimelineEdit>) => applyEdits(from, edits);
/** Each marker that shows as `id@frame` or `id@frame+length`, with its clip when it has one. */
const placed = (timeline: Timeline) =>
  timelineMarkers(timeline).map(
    (marker) =>
      `${marker.id}@${marker.frame}${marker.durationFrames > 0 ? `+${marker.durationFrames}` : ""}${marker.clipId === null ? "" : ` on ${marker.clipId}`}`,
  );

// A note at 50, a range over 110–170, a note at 250, and one pinned to v2's picture at 130.
const marked = edited(
  base,
  { kind: "addMarker", markerId: "m1", frame: 50, name: "Open cold" },
  {
    kind: "addMarker",
    markerId: "m2",
    frame: 110,
    duration: 60,
    name: "B-roll here",
    color: "BLUE",
  },
  { kind: "addMarker", markerId: "m3", frame: 250, name: "Cut too early", note: "lose two frames" },
  { kind: "addMarker", markerId: "m4", frame: 130, clipId: "v2", name: "Smile", author: "agent" },
);

describe("marker edits", () => {
  it("adds, changes and removes markers", () => {
    expect(placed(marked)).toEqual(["m1@50", "m2@110+60", "m4@130 on v2", "m3@250"]);
    expect(marked.tracks.markers?.[1]).toMatchObject({
      OTIO_SCHEMA: "Marker.2",
      name: "B-roll here",
      color: "BLUE",
      marked_range: timeRange(110, 60, RATE),
    });

    const changed = edited(
      marked,
      { kind: "setMarker", markerId: "m3", frame: 240, note: "three frames", resolved: true },
      { kind: "removeMarker", markerId: "m1" },
      { kind: "setMarker", markerId: "gone", name: "ignored" },
    );
    expect(placed(changed)).toEqual(["m2@110+60", "m4@130 on v2", "m3@240"]);
    expect(markersText(changed).split("\n")).toEqual([
      "# markers · M frame #markerId author open|done name: note",
      "M 110-170 #m2 user open B-roll here",
      "M 130 #m4 agent open on #v2 Smile",
      "M 240 #m3 user done Cut too early: three frames",
    ]);
    // An id comes from the marker's place and words, so a removed marker's id is not handed on
    // and replaying the same edit gives the same id.
    const hook: TimelineEdit = { kind: "addMarker", frame: 10, name: "Hook" };
    const ids = (timeline: Timeline) => timelineMarkers(timeline).map((marker) => marker.id);
    expect(ids(edited(base, hook))).toEqual(ids(edited(base, hook)));
    expect(new Set(ids(edited(base, hook, hook, { ...hook, frame: 11 }))).size).toBe(3);
    // A timeline whose markers are all removed reads as one that never had any.
    const cleared = edited(
      marked,
      ...["m1", "m2", "m3", "m4"].map((markerId): TimelineEdit => ({
        kind: "removeMarker",
        markerId,
      })),
    );
    expect(cleared).toEqual(edited(base, { kind: "setEnabled", clipId: "v1", enabled: true }));
  });

  it("ripples sequence markers with a cut, and leaves them when no time is removed", () => {
    // Extract 100–160: m2 starts inside and loses the frames cut from under it; m3 follows.
    expect(
      placed(edited(marked, { kind: "removeRange", start: 100, end: 160, ripple: true })),
    ).toEqual(["m1@50", "m2@100+10", "m3@190"]);
    // A cut before a point marker's frame but over it lands the marker on the cut.
    expect(
      placed(edited(marked, { kind: "removeRange", start: 20, end: 80, ripple: true })),
    ).toEqual(["m1@20", "m2@50+60", "m4@70 on v2", "m3@190"]);
    // A lift leaves a gap, so nothing after it moves.
    expect(
      placed(edited(marked, { kind: "removeRange", start: 20, end: 80, ripple: false })),
    ).toEqual(placed(marked));
    // A magnetic drag re-times one track, not the sequence.
    expect(
      placed(
        edited(marked, {
          kind: "move",
          clipId: "v1",
          toTrack: "V1",
          startFrame: 300,
          magnetic: true,
        }),
      ).filter((entry) => !entry.includes(" on ")),
    ).toEqual(["m1@50", "m2@110+60", "m3@250"]);
  });

  it("ripples sequence markers when a ripple delete closes a clip's gap", () => {
    const solo = edited(
      { ...base, tracks: { ...base.tracks, children: base.tracks.children.slice(0, 1) } },
      { kind: "addMarker", markerId: "m1", frame: 150, name: "inside" },
      { kind: "addMarker", markerId: "m2", frame: 250, name: "after" },
      { kind: "rippleDelete", clipId: "v2" },
    );
    expect(placed(solo)).toEqual(["m1@100", "m2@150"]);
  });

  it("keeps a clip's marker on the same picture through moves, trims, ripples and cuts", () => {
    const at = (...edits: ReadonlyArray<TimelineEdit>) =>
      placed(edited(marked, ...edits)).filter((entry) => entry.startsWith("m4"));
    expect(at({ kind: "move", clipId: "v2", toTrack: "V1", startFrame: 400 })).toEqual([
      "m4@430 on v2",
    ]);
    // Trimming the head moves the clip's start, not the picture the marker is on.
    expect(at({ kind: "trim", clipId: "v2", edge: "start", frame: 120 })).toEqual(["m4@130 on v2"]);
    // Trimmed off, it stops showing; it is still on the clip when the trim is taken back.
    const hidden: ReadonlyArray<TimelineEdit> = [
      { kind: "trim", clipId: "v2", edge: "start", frame: 140 },
    ];
    expect(at(...hidden)).toEqual([]);
    expect(at(...hidden, { kind: "trim", clipId: "v2", edge: "start", frame: 100 })).toEqual([
      "m4@130 on v2",
    ]);
    expect(at({ kind: "removeRange", start: 0, end: 50, ripple: true })).toEqual(["m4@80 on v2"]);
    // After a cut the marker shows on the piece that plays its frame.
    expect(at({ kind: "split", frame: 120 })).toEqual(["m4@130 on v2~120"]);
    expect(at({ kind: "setMarker", markerId: "m4", frame: 160 })).toEqual(["m4@160 on v2"]);
  });
});

describe("marker changes", () => {
  it("reports markers added, changed and removed, and not ones that only rode a clip", () => {
    const next = edited(
      marked,
      { kind: "addMarker", markerId: "m5", frame: 10, name: "Hook", author: "agent" },
      { kind: "setMarker", markerId: "m3", resolved: true },
      { kind: "setMarker", markerId: "m2", frame: 120, color: "RED" },
      { kind: "removeMarker", markerId: "m1" },
      { kind: "move", clipId: "v3", toTrack: "V1", startFrame: 400 },
    );
    const diff = diffTimelines(marked, next);
    expect(diffText(diff).split("\n")).toEqual([
      "moved V1 200-300 → V1 400-500 #v3 v3",
      'added marker 10 #m5 "Hook"',
      'removed marker 50 #m1 "Open cold"',
      'changed marker 120-180 #m2 "B-roll here": position, colour',
      'changed marker 250 #m3 "Cut too early": resolved',
    ]);
    expect(diffSentences(diff).slice(1)).toEqual([
      "Added marker “Hook” at 0:00",
      "Removed marker “Open cold” from 0:01",
      "Changed the position and colour of marker “B-roll here” at 0:04",
      "Resolved marker “Cut too early” at 0:08",
    ]);
    // v2 moved and took its marker along: the clip moved, the marker did not change.
    expect(
      diffText(
        diffTimelines(
          marked,
          edited(marked, { kind: "move", clipId: "v2", toTrack: "V1", startFrame: 400 }),
        ),
      ),
    ).toBe("moved V1 100-200 → V1 400-500 #v2 v2");
  });
});

/** A marker as a pull from Premiere reads it. */
const premiereMarker = (id: string, frame: number, name: string, comment = ""): Marker => ({
  OTIO_SCHEMA: "Marker.2",
  name,
  color: "GREEN",
  comment,
  marked_range: timeRange(frame, 0, RATE),
  metadata: { [TIMELINE_NAMESPACE]: { id, author: "user" }, premiere: { markerId: `${id}-guid` } },
});
const withMarkers = (timeline: Timeline, markers: ReadonlyArray<Marker>): Timeline => ({
  ...timeline,
  tracks: { ...timeline.tracks, markers },
});

describe("merging markers", () => {
  // Premiere's last save: the user's note at 250 and a chapter mark at 20.
  const pulled = withMarkers(base, [
    premiereMarker("aaaa1111", 20, "Chapter"),
    premiereMarker("bbbb2222", 250, "Cut too early", "lose two frames"),
  ]);

  it("keeps a note answered here and markers the user set in Premiere since", () => {
    // Here: the agent resolves the note and flags a frame of v2.
    const ours = edited(
      pulled,
      { kind: "setMarker", markerId: "bbbb2222", resolved: true },
      { kind: "addMarker", markerId: "m1", frame: 150, name: "Check focus", author: "agent" },
      {
        kind: "addMarker",
        markerId: "m2",
        frame: 130,
        clipId: "v2",
        name: "Smile",
        author: "agent",
      },
    );
    // In Premiere: the first 60 frames are cut out and a new marker is set.
    const theirs = withMarkers(
      edited(pulled, { kind: "removeRange", start: 0, end: 60, ripple: true }),
      [
        premiereMarker("aaaa1111", 0, "Chapter"),
        premiereMarker("bbbb2222", 190, "Cut too early", "lose two frames"),
        premiereMarker("cccc3333", 100, "New in Premiere"),
      ],
    );
    const merged = mergeTimelines(pulled, ours, theirs);
    expect(merged.conflicts).toEqual([]);
    expect(markersText(merged.timeline).split("\n").slice(1)).toEqual([
      "M 0 #aaaa1111 user open Chapter",
      "M 70 #m2 agent open on #v2 Smile",
      // Made here at 150, and Premiere cut 60 frames from before it.
      "M 90 #m1 agent open Check focus",
      "M 100 #cccc3333 user open New in Premiere",
      "M 190 #bbbb2222 user done Cut too early: lose two frames",
    ]);
  });

  it("keeps Premiere's version of a marker both sides changed, and says so", () => {
    const ours = edited(
      pulled,
      { kind: "setMarker", markerId: "bbbb2222", note: "agent: trimmed it", color: "RED" },
      { kind: "removeMarker", markerId: "aaaa1111" },
    );
    const theirs = withMarkers(pulled, [
      premiereMarker("aaaa1111", 20, "Chapter one"),
      premiereMarker("bbbb2222", 250, "Cut too early", "actually fine"),
    ]);
    const merged = mergeTimelines(pulled, ours, theirs);
    expect(merged.conflicts.map((conflict) => conflict.message)).toEqual([
      "marker “Cut too early” at 0:08 had its note changed on both sides; Premiere's version was kept.",
      "marker “Chapter” at 0:00 was changed in Premiere, so it was not removed.",
    ]);
    // The colour only we changed still lands on Premiere's marker.
    expect(timelineMarkers(merged.timeline)).toMatchObject([
      { id: "aaaa1111", name: "Chapter one" },
      { id: "bbbb2222", note: "actually fine", color: "RED" },
    ]);
  });

  it("takes a marker made here as the one Premiere now holds under its own id", () => {
    const ours = edited(pulled, { kind: "addMarker", frame: 150, name: "Check focus" });
    const theirs = withMarkers(pulled, [
      ...(pulled.tracks.markers ?? []),
      premiereMarker("dddd4444", 150, "Check focus"),
    ]);
    expect(mergeTimelines(pulled, ours, theirs).timeline.tracks.markers).toEqual(
      theirs.tracks.markers,
    );
    expect(diffTimelines(theirs, ours).changes).toEqual([]);
  });
});

describe("Premiere's marker comment", () => {
  it("carries who made a marker and whether it is resolved, and reads them back", () => {
    const cases = [
      { note: "lose two frames", author: "user", resolved: false },
      { note: "lose two frames", author: "agent", resolved: true },
      { note: "", author: "user", resolved: true },
    ] as const;
    expect(cases.map(premiereMarkerComment)).toEqual([
      "lose two frames",
      "lose two frames\n[stellar: agent, resolved]",
      "[stellar: resolved]",
    ]);
    for (const marker of cases) {
      expect(parsePremiereMarkerComment(premiereMarkerComment(marker))).toEqual(marker);
    }
  });
});
