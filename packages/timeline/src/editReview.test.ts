import { describe, expect, it } from "vite-plus/test";

import { carryChange, frameOfAnchor, placeBetween } from "./editReview.ts";
import { applyEdits } from "./edits.ts";
import { layoutTimeline } from "./layout.ts";
import { timelineMarkers } from "./markers.ts";
import { type Clip, rationalTime, type Timeline, timeRange, type Track } from "./otio.ts";

const RATE = 30;

const clip = (id: string, frames: number): Clip => ({
  OTIO_SCHEMA: "Clip.2",
  name: id,
  source_range: timeRange(0, frames, RATE),
  media_references: {
    DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: `${id}.mov`, metadata: {} },
  },
  active_media_reference_key: "DEFAULT_MEDIA",
  enabled: true,
  metadata: { premiere: { nodeId: id } },
});

const track = (name: string, children: Track["children"]): Track => ({
  OTIO_SCHEMA: "Track.1",
  name,
  kind: "Video",
  children,
  enabled: true,
  metadata: {},
});

// V1: a 0–100, b 100–200, c 200–300, d 300–400.
const base: Timeline = {
  OTIO_SCHEMA: "Timeline.1",
  name: "t",
  global_start_time: rationalTime(0, RATE),
  tracks: {
    OTIO_SCHEMA: "Stack.1",
    name: "tracks",
    enabled: true,
    metadata: {},
    children: [track("V1", [clip("a", 100), clip("b", 100), clip("c", 100), clip("d", 100)])],
  },
  metadata: {},
};

const spans = (timeline: Timeline) =>
  layoutTimeline(timeline).tracks.flatMap((laidOut) =>
    laidOut.clips.map((item) => `${item.clip.name} ${item.startFrame}-${item.endFrame}`),
  );

// The edit under review: a cut inside b that closes up.
const cut = applyEdits(base, [{ kind: "removeRange", start: 120, end: 150, ripple: true }]);

describe("placeBetween", () => {
  it("places a cut at its join, says what it took out, and finds the join again later", () => {
    expect(spans(cut)).toEqual(["a 0-100", "b 100-120", "b 120-170", "c 170-270", "d 270-370"]);
    const place = placeBetween(base, cut);
    expect(place).toEqual({
      frame: 120,
      removed: { start: 120, end: 150 },
      // b's footage from 50 frames in is what plays after the join.
      anchor: { track: "V1", target: "b.mov", seconds: 50 / RATE },
    });
    // A later cut ahead of it, inside the same clip's first piece, moves the join 5 frames.
    const later = applyEdits(cut, [{ kind: "removeRange", start: 105, end: 110, ripple: true }]);
    expect(place.anchor && frameOfAnchor(later, place.anchor, 120)).toBe(115);
    // With the footage gone there is nowhere to point.
    const gone = applyEdits(cut, [{ kind: "removeRange", start: 100, end: 170, ripple: true }]);
    expect(place.anchor && frameOfAnchor(gone, place.anchor, 120)).toBeNull();
  });

  it("measures a cut across clips, a lifted clip, and an edit that takes nothing out", () => {
    const across = applyEdits(base, [{ kind: "removeRange", start: 150, end: 230, ripple: true }]);
    expect(placeBetween(base, across).removed).toEqual({ start: 150, end: 230 });
    const lifted = applyEdits(base, [{ kind: "delete", clipId: "c" }]);
    expect(placeBetween(base, lifted)).toMatchObject({
      frame: 200,
      removed: { start: 200, end: 300 },
      anchor: null,
    });
    const disabled = applyEdits(base, [{ kind: "setEnabled", clipId: "c", enabled: false }]);
    expect(placeBetween(base, disabled)).toMatchObject({ frame: 200, removed: null });
  });
});

describe("carryChange", () => {
  it("undoes one edit and leaves a later edit elsewhere as it is, then puts it back", () => {
    // After the cut: a cut ahead of it, d's end trimmed by 20 frames, and a marker on d.
    const later = applyEdits(cut, [
      { kind: "removeRange", start: 30, end: 50, ripple: true },
      { kind: "trim", clipId: "d", edge: "end", frame: 330 },
      { kind: "addMarker", frame: 300, author: "agent", name: "look" },
    ]);
    expect(spans(later).slice(-2)).toEqual(["c 150-250", "d 250-330"]);
    const undone = carryChange(cut, base, later);
    expect(undone.overlaps).toEqual([]);
    expect(spans(undone.timeline)).toEqual([
      "a 0-30",
      "a 30-80",
      "b 80-180",
      "c 180-280",
      "d 280-360",
    ]);
    expect(timelineMarkers(undone.timeline).map((marker) => marker.frame)).toEqual([330]);

    const redone = carryChange(base, cut, undone.timeline);
    expect(redone.overlaps).toEqual([]);
    expect(spans(redone.timeline)).toEqual(spans(later));
  });

  it("refuses when a later edit changed what the edit made", () => {
    // The piece of b after the cut is trimmed, so the cut can't be closed over as it was.
    const piece = layoutTimeline(cut).tracks[0]?.clips[2]?.key ?? "";
    const later = applyEdits(cut, [{ kind: "trim", clipId: piece, edge: "start", frame: 130 }]);
    expect(carryChange(cut, base, later).overlaps).toEqual(["b"]);
    // So is a later cut across the join.
    const across = applyEdits(cut, [{ kind: "removeRange", start: 110, end: 130, ripple: true }]);
    expect(carryChange(cut, base, across).overlaps).not.toEqual([]);
  });

  it("refuses when a later edit removed a clip the edit changed", () => {
    const trimmed = applyEdits(base, [{ kind: "trim", clipId: "c", edge: "end", frame: 250 }]);
    const later = applyEdits(trimmed, [{ kind: "delete", clipId: "c" }]);
    expect(carryChange(trimmed, base, later).overlaps).toEqual(["c"]);
  });
});
