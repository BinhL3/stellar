import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { applyEdits } from "./edits.ts";
import { rationalTime, serializeTimeline, type Timeline, timeRange } from "./otio.ts";
import {
  decideEdits,
  historySteps,
  readHistory,
  recordVersion,
  RETAIN_DAYS,
  RETAIN_RECENT,
  retainVersions,
  type TimelineVersion,
} from "./versions.ts";

const DAY = 86_400_000;
const version = (index: number, at: number, steps: Partial<TimelineVersion> = {}) =>
  ({
    id: `v${index}`,
    at,
    by: "user",
    label: "Committed",
    changes: [],
    hash: `hash${index}`,
    base: null,
    parent: index > 1 ? `v${index - 1}` : null,
    ...steps,
  }) satisfies TimelineVersion;

describe("retainVersions", () => {
  it("keeps every recent version, then the last of each earlier day", () => {
    // Four versions a day for sixty days, then a long session today.
    const old = Array.from({ length: 240 }, (_, index) =>
      version(index + 1, Math.floor(index / 4) * DAY + (index % 4) * 1000),
    );
    const today = Array.from({ length: RETAIN_RECENT }, (_, index) =>
      version(241 + index, 60 * DAY + index),
    );
    const kept = retainVersions([...old, ...today]);
    expect(kept.slice(-RETAIN_RECENT)).toEqual(today);
    const earlier = kept.slice(0, -RETAIN_RECENT);
    // One per day, the day's last, for the newest thirty of those days; oldest first.
    expect(earlier).toHaveLength(RETAIN_DAYS);
    expect(earlier.map((kept) => kept.id).slice(0, 2)).toEqual(["v124", "v128"]);
    expect(earlier.at(-1)?.id).toBe("v240");
    // Nothing is dropped until there is more than the recent window.
    expect(retainVersions(today)).toBe(today);
  });
});

describe("historySteps", () => {
  it("steps back through parents and forward again after an undo", () => {
    const history = (versions: ReadonlyArray<TimelineVersion>) => ({
      version: 1 as const,
      next: versions.length + 1,
      base: null,
      versions,
    });
    const three = [version(1, 0), version(2, 1), version(3, 2)];
    expect(historySteps(history(three))).toEqual({ undo: "v2", redo: null });
    // v4 is the undo of v3: it holds v2's text, undoes on to v1 and redoes to v3.
    const undone = [...three, version(4, 3, { parent: "v1", redo: "v3" })];
    expect(historySteps(history(undone))).toEqual({ undo: "v1", redo: "v3" });
    // A step whose version has been thinned out is not offered.
    expect(historySteps(history(undone.slice(1)))).toEqual({ undo: null, redo: "v3" });
    expect(historySteps(history([]))).toEqual({ undo: null, redo: null });
  });
});

describe("recordVersion", () => {
  const timeline: Timeline = {
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
          children: [
            {
              OTIO_SCHEMA: "Clip.2",
              name: "a",
              source_range: timeRange(0, 300, 30),
              media_references: {
                DEFAULT_MEDIA: {
                  OTIO_SCHEMA: "ExternalReference.1",
                  target_url: "a.mov",
                  metadata: {},
                },
              },
              active_media_reference_key: "DEFAULT_MEDIA",
              enabled: true,
              metadata: { premiere: { nodeId: "a" } },
            },
          ],
        },
      ],
    },
    metadata: {},
  };

  it.effect("keeps an edit's summary, check and place, and what the user decides on it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-versions-" });
      const timelinePath = "timelines/main.otio";
      const start = serializeTimeline(timeline);
      const cut = applyEdits(timeline, [{ kind: "removeRange", start: 60, end: 90, ripple: true }]);
      const cutText = serializeTimeline(cut);
      const record = (text: string, before: string, review?: { summary: string; check?: string }) =>
        recordVersion({
          projectDir,
          timelinePath,
          text,
          before,
          by: "agent",
          label: "Edited by an agent",
          ...(review === undefined ? {} : { review }),
        });

      yield* record(cutText, start, {
        summary: "Cut the false start at 0:02",
        check: "The breath before the next line may be clipped",
      });
      // An edit with no summary is a version and not a reviewed edit; the next one is E2.
      const trimmed = serializeTimeline(
        applyEdits(cut, [{ kind: "trim", clipId: "a", edge: "end", frame: 50 }]),
      );
      yield* record(trimmed, cutText);
      yield* record(cutText, trimmed, { summary: "Put the trim back" });

      const history = yield* readHistory(projectDir, timelinePath);
      expect(history.versions.map((version) => [version.id, version.edit])).toEqual([
        ["v1", undefined],
        [
          "v2",
          {
            number: 1,
            summary: "Cut the false start at 0:02",
            check: "The breath before the next line may be clipped",
            frame: 60,
            removed: { start: 60, end: 90 },
            anchor: { track: "V1", target: "a.mov", seconds: 3 },
          },
        ],
        ["v3", undefined],
        ["v4", expect.objectContaining({ number: 2, summary: "Put the trim back" })],
      ]);

      const decisions = Effect.map(readHistory(projectDir, timelinePath), (read) =>
        read.versions.flatMap((version) => version.edit?.decision ?? []),
      );
      yield* decideEdits({ projectDir, timelinePath, numbers: [1, 2], decision: "undone" });
      yield* decideEdits({ projectDir, timelinePath, numbers: [2], decision: "kept" });
      expect(yield* decisions).toEqual(["undone", "kept"]);
      yield* decideEdits({ projectDir, timelinePath, numbers: [1], decision: null });
      expect(yield* decisions).toEqual(["kept"]);
      // Deciding rewrites the index only: the numbering carries on.
      expect((yield* readHistory(projectDir, timelinePath)).nextEdit).toBe(3);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
