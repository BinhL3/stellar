import { assert, it } from "@effect/vitest";

import { footageStringout } from "../../packages/timeline/src/footage.ts";
import { levelsOf } from "../../packages/timeline/src/levels.ts";
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
        // An argument this checkout's tool does not have is dropped, not refused.
        { summary: "Cut one and three.", argumentAddedLater: true },
      ),
      // The next call numbers the words that are left.
      edit([{ kind: "removeWords", fromWord: 2, toWord: 2 }]),
    ),
  });
  assert.deepEqual(
    calls.map((call) => [call.status, call.summary]),
    [
      ["applied", "Cut one and three."],
      ["applied", undefined],
    ],
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
  assert.deepEqual(heard(timeline).slice(1), [
    "1:one@30 (0.50s unmeasured) 2:two@90 (0.50s unmeasured) 3:three@150",
  ]);
});

it("places word cuts and pause trims on measured quiet, and refuses an edge inside a sounding word", () => {
  // Speech at -20 dBFS where the words are timed and room tone at -60 elsewhere, except that
  // "three" is heard 50 ms before its timing says.
  const spoken = [
    [0.5, 1],
    [1.5, 2],
    [2.45, 3],
    [3.5, 4],
  ] as const;
  const levels = new Map([
    [
      "Footage/a.mov",
      levelsOf(
        Array.from({ length: 400 }, (_, i) =>
          spoken.some(([from, to]) => i >= Math.round(from * 100) && i < Math.round(to * 100))
            ? -20
            : -60,
        ),
        0.01,
      ),
    ],
  ]);
  const { timeline, calls } = replayPlan({
    start,
    transcripts,
    levels,
    plan: plan(
      // Frame 45 is 0.75 s, in the middle of "one".
      edit([{ kind: "removeRange", start: 45, end: 120, ripple: true }]),
      edit([
        { kind: "removeWords", fromWord: 2, toWord: 2, ripple: true },
        { kind: "trimPause", afterWord: 3 },
        { kind: "trimPause", afterWord: 1, leave: 1 },
      ]),
    ),
  });
  assert.equal(calls[0]?.status, "refused");
  assert.match(
    calls[0]?.note ?? "",
    /^Edit 1 \(removeRange\): it would end #1:0 \(a\.mov, A1\) inside word 1 "one" while it sounds/,
  );
  assert.deepEqual(
    [calls[1]?.status, calls[1]?.note],
    [
      "applied",
      "left out: the pause after 1:one: 0.50s of quiet, already about 1.00s; nothing removed",
    ],
  );
  // "two" went from frame 89, a frame before its first sound, to 146, before "three" is heard;
  // the half second after "three" is down to 0.25 s.
  assert.deepEqual(heard(timeline), [
    "A1 0-89 #1:0 a.mov",
    "1:one@30",
    "A1 89-132 #1:0~146 a.mov",
    "2:three@93",
    "A1 132-168 #1:0~146~147 a.mov",
    "3:four@138",
  ]);
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
