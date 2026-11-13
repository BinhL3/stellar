import { assert, it } from "@effect/vitest";

import { applyEdits } from "../../packages/timeline/src/edits.ts";
import { footageStringout } from "../../packages/timeline/src/footage.ts";
import { loadCase } from "./case.ts";
import { replayPlan } from "./replay.ts";
import { scoreCut } from "./score.ts";

const fixture = (id: string) => {
  const entry = loadCase(new URL(`./fixtures/${id}`, import.meta.url).pathname);
  const { timeline } = replayPlan({ ...entry, plan: entry.plan! });
  return scoreCut({ ...entry, result: timeline, log: entry.plan });
};

it("scores a replayed cut against the editor's finished timeline", () => {
  const score = fixture("hook-retake");
  // The first take of the hook is said again in what plays; "thanks" is not.
  assert.deepEqual(score.removed, {
    words: 7,
    seconds: 3.5,
    byKind: { retake: 0.9, filler: 0.45, speech: 0.5, pause: 1.65, untranscribed: 0 },
  });
  // The agent cut "thanks", which the editor kept, and nothing the editor cut was left in.
  assert.deepInclude(score.words, { removed: 7, referenceRemoved: 6, precision: 0.857, recall: 1 });
  assert.deepInclude(score.edges, { count: 6, insideWord: 0 });
  // A word cut runs to the next word's start, so its join has no pause; the pause the agent left
  // alone is no join. The editor tightened that pause to 0.4 s, which is one more join.
  assert.deepInclude(score.joins, { count: 1, median: 0, distribution: [1, 0, 0, 0, 0] });
  assert.deepInclude(score.reference?.joins, { count: 2, median: 0.2, max: 0.4 });
  assert.deepEqual(score.reference?.sharedJoins, {
    count: 1,
    medianDifference: 0,
    medianAbsoluteDifference: 0,
  });
  assert.equal(score.timeToFirstEditSeconds, 21);
});

it("scores against keep and undo decisions, leaving unjudged words out", () => {
  const score = fixture("hook-retake-decisions");
  assert.deepInclude(score.words, { labelled: 7, agreed: 6, precision: 0.857, recall: 1 });
  assert.isNull(score.reference);
});

const start = footageStringout(
  [{ target: "Footage/a.mov", duration: 4, width: 1080, height: 1920 }],
  "/home/user/Shorts/acme",
);
const transcripts = new Map([
  [
    "Footage/a.mov",
    [
      { w: "one", start: 0.5, end: 1 },
      { w: "two", start: 1.5, end: 2 },
      { w: "three", start: 2.5, end: 3 },
    ],
  ],
]);

it("counts a cut edge that lands inside a word, and the pause a typed range leaves", () => {
  // Frames 45-120 at 60 fps: from the middle of "one" to half a second before "three".
  const result = applyEdits(start, [{ kind: "removeRange", start: 45, end: 120, ripple: true }]);
  const score = scoreCut({ start, result, transcripts });
  assert.deepEqual(score.edges.inside, [{ media: "Footage/a.mov", at: 0.75, word: 0 }]);
  assert.equal(score.edges.count, 2);
  // "one" still starts inside its clip, so it counts as kept; only "two" is gone.
  assert.equal(score.removed.words, 1);
  assert.deepInclude(score.joins, { count: 1, median: 0.25, distribution: [0, 0, 1, 0, 0] });
  assert.isNull(score.words);
  assert.isNull(score.timeToFirstEditSeconds);
});

it("treats words no decision names as kept only when the decisions are complete", () => {
  const result = applyEdits(start, [{ kind: "removeRange", start: 90, end: 150, ripple: true }]);
  const decisions = [{ fromWord: 3, toWord: 3, decision: "added" as const }];
  const partial = scoreCut({
    start,
    result,
    transcripts,
    reference: { kind: "decisions", decisions },
  });
  assert.deepInclude(partial.words, { labelled: 1, removed: 0, precision: null, recall: 0 });
  const complete = scoreCut({
    start,
    result,
    transcripts,
    reference: { kind: "decisions", decisions, complete: true },
  });
  assert.deepInclude(complete.words, { labelled: 3, removed: 1, precision: 0, recall: 0 });
});

it("counts removed footage with no transcript apart from pauses", () => {
  const result = applyEdits(start, [{ kind: "removeRange", start: 0, end: 60, ripple: true }]);
  const score = scoreCut({ start, result, transcripts: new Map() });
  assert.deepInclude(score.removed.byKind, { untranscribed: 1, pause: 0 });
});
