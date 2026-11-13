import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { applyEdits, type TimelineEdit } from "@t3tools/timeline/edits";
import { layoutTimeline } from "@t3tools/timeline/layout";
import {
  type Clip,
  rationalTime,
  serializeTimeline,
  type Timeline,
  timeRange,
} from "@t3tools/timeline/otio";
import { readHistory } from "@t3tools/timeline/versions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  commitTimelineText,
  listTimelineEdits,
  restoreTimelineVersion,
  reviewTimelineEdit,
} from "./TimelineHistory.ts";

const clip = (id: string): Clip => ({
  OTIO_SCHEMA: "Clip.2",
  name: id,
  source_range: timeRange(0, 100, 30),
  media_references: {
    DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: `${id}.mov`, metadata: {} },
  },
  active_media_reference_key: "DEFAULT_MEDIA",
  enabled: true,
  metadata: { premiere: { nodeId: id } },
});

// V1: a 0–100, b 100–200.
const start: Timeline = {
  OTIO_SCHEMA: "Timeline.1",
  name: "t",
  global_start_time: rationalTime(0, 30),
  tracks: {
    OTIO_SCHEMA: "Stack.1",
    name: "tracks",
    enabled: true,
    metadata: {},
    children: [
      {
        OTIO_SCHEMA: "Track.1",
        name: "V1",
        kind: "Video",
        enabled: true,
        metadata: {},
        children: [clip("a"), clip("b")],
      },
    ],
  },
  metadata: {},
};

const decodeTimeline = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

describe("reviewTimelineEdit", () => {
  it.effect("keeps, undoes and puts back one edit under the edits made after it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-edits-" });
      const timelinePath = "timelines/main.otio";
      const file = path.join(projectDir, timelinePath);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, serializeTimeline(start));

      const read = Effect.map(
        Effect.flatMap(fs.readFileString(file), decodeTimeline),
        (value) => value as Timeline,
      );
      const spans = Effect.map(read, (timeline) =>
        layoutTimeline(timeline).tracks.flatMap((track) =>
          track.clips.map((item) => `${item.clip.name} ${item.startFrame}-${item.endFrame}`),
        ),
      );
      const agentEdit = Effect.fn("test.agentEdit")(function* (
        edits: ReadonlyArray<TimelineEdit>,
        review: { readonly summary: string; readonly check?: string },
      ) {
        yield* commitTimelineText({
          projectDir,
          timelinePath,
          text: serializeTimeline(applyEdits(yield* read, edits)),
          by: "agent",
          label: "Edited by an agent",
          review,
        });
      });
      const review = (
        edit: number,
        action: "keep" | "reopen" | "undo" | "redo" | "restoreBefore",
      ) => reviewTimelineEdit({ projectDir, timelinePath, edit, action });
      const states = (view: {
        readonly edits: ReadonlyArray<{ number: number; decision: unknown }>;
      }) => view.edits.map((edit) => `E${edit.number} ${edit.decision ?? "open"}`);

      yield* agentEdit([{ kind: "removeRange", start: 20, end: 40, ripple: true }], {
        summary: "Cut the false start",
        check: "Listen for a clipped breath",
      });
      yield* agentEdit([{ kind: "trim", clipId: "b", edge: "end", frame: 150 }], {
        summary: "Ended on the laugh",
      });
      assert.deepStrictEqual(yield* spans, ["a 0-20", "a 20-80", "b 80-150"]);
      const listed = yield* listTimelineEdits(projectDir, timelinePath);
      assert.deepStrictEqual(
        listed.edits.map((edit) => [
          edit.number,
          edit.version,
          edit.before,
          edit.check,
          edit.frame,
        ]),
        [
          [2, "v3", "v2", null, 150],
          [1, "v2", "v1", "Listen for a clipped breath", 20],
        ],
      );
      assert.deepStrictEqual(listed.edits[1]?.removed, { start: 20, end: 40 });

      assert.deepStrictEqual(states(yield* review(1, "keep")), ["E2 open", "E1 kept"]);
      assert.deepStrictEqual(states(yield* review(1, "reopen")), ["E2 open", "E1 open"]);

      // E1 comes out from under E2, which stays.
      const undone = yield* review(1, "undo");
      assert.strictEqual(undone.blocked, null);
      assert.deepStrictEqual(states(undone), ["E2 open", "E1 undone"]);
      assert.deepStrictEqual(yield* spans, ["a 0-100", "b 100-170"]);
      const head = (yield* readHistory(projectDir, timelinePath)).versions.at(-1);
      assert.deepStrictEqual([head?.by, head?.label], ["user", "Undid E1: Cut the false start"]);
      // A plain history step moves the timeline, and each edit's state follows it: stepping
      // back over the undo brings E1's cut back, and stepping forward takes it out again.
      const step = (direction: "undo" | "redo") =>
        Effect.andThen(
          restoreTimelineVersion({ projectDir, timelinePath, step: direction, by: "user" }),
          listTimelineEdits(projectDir, timelinePath),
        );
      assert.deepStrictEqual(states(yield* step("undo")), ["E2 open", "E1 open"]);
      assert.deepStrictEqual(yield* spans, ["a 0-20", "a 20-80", "b 80-150"]);
      assert.deepStrictEqual(states(yield* step("redo")), ["E2 open", "E1 undone"]);
      assert.deepStrictEqual(yield* spans, ["a 0-100", "b 100-170"]);
      // An undone edit can't be kept, only put back.
      assert.include((yield* review(1, "keep")).blocked ?? "", "Put it back first");
      const redone = yield* review(1, "redo");
      assert.deepStrictEqual(states(redone), ["E2 open", "E1 open"]);
      assert.deepStrictEqual(yield* spans, ["a 0-20", "a 20-80", "b 80-150"]);

      // E3 trims the piece E1 made, so E1 can no longer come out on its own: nothing changes.
      const piece = layoutTimeline(yield* read).tracks[0]?.clips[1]?.key ?? "";
      yield* agentEdit([{ kind: "trim", clipId: piece, edge: "start", frame: 30 }], {
        summary: "Tightened the pickup",
      });
      const held = yield* fs.readFileString(file);
      const refused = yield* review(1, "undo");
      assert.include(refused.blocked ?? "", "E1 can't be undone on its own");
      assert.strictEqual(yield* fs.readFileString(file), held);
      assert.deepStrictEqual(states(refused), ["E3 open", "E2 open", "E1 open"]);

      // The way out it offers: the version before E1, which takes E2 and E3 with it.
      const restored = yield* review(1, "restoreBefore");
      assert.deepStrictEqual(states(restored), ["E3 undone", "E2 undone", "E1 undone"]);
      assert.deepStrictEqual(yield* spans, ["a 0-100", "b 100-200"]);
      // Stepping back from that restore brings all three back.
      assert.deepStrictEqual(states(yield* step("undo")), ["E3 open", "E2 open", "E1 open"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
