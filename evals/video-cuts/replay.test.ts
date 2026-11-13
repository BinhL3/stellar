import { assert, it } from "@effect/vitest";

import { footageStringout } from "../../packages/timeline/src/footage.ts";
import { timelineWords, wordsText } from "../../packages/timeline/src/words.ts";
import { assertOutsideRepo } from "./case.ts";
import { type Plan, planFromTurnItems, replayPlan } from "./replay.ts";

const start = footageStringout(
  [{ target: "Footage/a.mov", duration: 4, width: 1080, height: 1920 }],
  "/home/user/Shorts/acme",
);
const transcripts = new Map([
  [
    "Footage/a.mov",
    ["one", "two", "three", "four"].map((w, index) => ({
      w,
      start: 0.5 + index,
      end: 1 + index,
    })),
  ],
]);
const plan = (...calls: Plan["calls"]): Plan => ({ version: 1, calls });
const edit = (edits: ReadonlyArray<unknown>, more: object = {}) => ({
  tool: "mcp__t3-code__video_timeline_edit",
  input: { timeline: "timelines/main.otio", edits, ...more },
});
const heard = (timeline: typeof start) =>
  wordsText(timelineWords(timeline, transcripts)).split("\n").slice(1);

it("replays word cuts by the word numbers each call started with", () => {
  const { timeline, calls } = replayPlan({
    start,
    transcripts,
    plan: plan(
      { tool: "video_timeline_words", input: {} },
      // Both numbers are from before the call: the second cut follows the first one's ripple.
      edit(
        [
          { kind: "removeWords", fromWord: 1, toWord: 1, ripple: true },
          { kind: "removeWords", fromWord: 3, toWord: 3, ripple: true },
        ],
        // An argument this checkout's tool does not have yet is dropped, not refused.
        { summary: "Cut one and three." },
      ),
      // The next call numbers the words that are left.
      edit([{ kind: "removeWords", fromWord: 2, toWord: 2 }]),
    ),
  });
  assert.deepEqual(
    calls.map((call) => call.status),
    ["applied", "applied"],
  );
  assert.deepEqual(heard(timeline), [
    "A1 0-30 #1:0 a.mov (no words)",
    "A1 30-90 #1:0~90 a.mov",
    "1:two@30",
  ]);
});

it("refuses a whole call for one bad edit, and goes on with the next call", () => {
  const { timeline, calls } = replayPlan({
    start,
    transcripts,
    plan: plan(
      edit([
        { kind: "removeWords", fromWord: 1, toWord: 1, ripple: true },
        { kind: "delete", clipId: "nope" },
      ]),
      edit([{ kind: "aKindThisCheckoutLacks" }]),
      edit([{ kind: "removeWords", fromWord: 9, toWord: 9 }]),
      edit([{ kind: "removeRange", start: 0, end: 30, ripple: true }], { timeline: "other.otio" }),
      { tool: "video_voice_over", input: { action: "apply" } },
      edit([
        { kind: "removeWords", fromWord: 4, toWord: 4, ripple: true },
        { kind: "addMarker", frame: 0, note: "Cut four." },
      ]),
    ),
  });
  assert.deepEqual(
    calls.map((call) => [call.status, call.note]),
    [
      ["refused", "Edit 2 (delete): no clip #nope"],
      ["refused", "this checkout can't read the input"],
      ["refused", "Edit 1 (removeWords): no word 9 (the timeline has 4 words)"],
      ["skipped", "edits other.otio"],
      ["skipped", "this tool can't be replayed"],
      ["applied", "left out: addMarker"],
    ],
  );
  assert.deepEqual(heard(timeline).slice(1), ["1:one@30 2:two@90 3:three@150"]);
});

it("captures a thread's completed video calls as a plan, without their results", () => {
  const item = (toolName: string, runId: string, more: object = {}) => ({
    type: "dynamic_tool",
    toolName,
    status: "completed",
    runId,
    startedAt: "2026-01-01T12:00:21.000Z",
    input: { timeline: "timelines/main.otio" },
    output: { text: "1:one@30" },
    ...more,
  });
  const items = [
    item("Read", "run-1"),
    item("mcp__t3-code__video_timeline_words", "run-1"),
    item("mcp__t3-code__video_timeline_edit", "run-1", { status: "failed" }),
    item("t3_code.video_timeline_edit", "run-2", { startedAt: null }),
    { type: "assistant_message", text: "Done." },
  ];
  const runStarts = new Map([
    ["run-1", "2026-01-01T12:00:00.000Z"],
    ["run-2", "2026-01-01T13:00:00.000Z"],
  ]);
  assert.deepEqual(planFromTurnItems({ threadId: "thread-1", items, runStarts }), {
    version: 1,
    source: { thread: "thread-1", run: "run-1" },
    startedAt: "2026-01-01T12:00:00.000Z",
    calls: [
      {
        tool: "video_timeline_words",
        at: "2026-01-01T12:00:21.000Z",
        input: { timeline: "timelines/main.otio" },
      },
      { tool: "video_timeline_edit", input: { timeline: "timelines/main.otio" } },
    ],
  });
  const second = planFromTurnItems({ threadId: "thread-1", items, runStarts, runId: "run-2" });
  assert.equal(second.startedAt, "2026-01-01T13:00:00.000Z");
  assert.lengthOf(second.calls, 1);
});

it("keeps results out of the repository", () => {
  const here = import.meta.dirname;
  assert.throws(() => assertOutsideRepo(`${here}/fixtures/results.jsonl`), /inside the repository/);
  assert.doesNotThrow(() => assertOutsideRepo(`${here}/../runs/check/results.jsonl`));
  assert.doesNotThrow(() => assertOutsideRepo("/home/user/stellar-evals/results.jsonl"));
});
