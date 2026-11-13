# Video cuts

Scores a cut an agent made on a Stellar timeline, by code: what it removed, whether that agrees with a reference, where its edges land, and the pauses it leaves. No model judges anything, and nothing here calls a model, so every command costs $0.

It also replays a stored plan (the agent's edit tool calls) through this checkout's `packages/timeline` code. Replay the same plan before and after a tool change to see what the change does to the cut, without paying for a new run.

The metric set and the replay idea are adapted from [Forward-Future/scarlet](https://github.com/Forward-Future/scarlet)'s evals (MIT).

## Case data stays out of the repository

Real footage, transcripts, timelines, plans and every number derived from them never go in this repository. Cases live in the directory `STELLAR_EVAL_DATA` names, under `video-cuts/<case id>/`. The commands refuse to write inside the checkout, except under the gitignored `evals/runs/`.

`fixtures/` holds synthetic cases only: authored words, an Acme project, a hand-written plan. Keep it that way. A fixture is there to test the scorer and to show the file formats.

## Run

From `evals/`:

```sh
# The synthetic fixtures. Use this to check the setup.
pnpm video-cuts --cases video-cuts/fixtures --out runs/fixtures

# Every case in $STELLAR_EVAL_DATA/video-cuts.
export STELLAR_EVAL_DATA=~/stellar-eval-data
pnpm video-cuts --out runs/before

# After changing a tool or packages/timeline: the same plans, compared with the earlier run.
pnpm video-cuts --out runs/after --baseline runs/before/results.jsonl

# One case, with another plan than its own.
pnpm video-cuts --case hook-retake --plan ~/stellar-eval-data/plans/second-run.json --out runs/second
```

A run writes `results.jsonl` (one row per case with the full score and each replayed call's outcome), `summary.md` (the table it also prints; with `--baseline`, each number carries its change), and `<case id>.otio` for every replayed case.

## What it measures

Times are seconds of each source file, so two cuts of the same footage compare whatever their timelines look like. A word counts as kept exactly when `video_timeline_words` would list it.

- **Removed time by kind.** `retake`: a removed run of three or more words that the cut still says somewhere else. `filler`: a removed hesitation word (`DEFAULT_FILLERS` in `score.ts`, or the case's `fillers`). `speech`: any other removed word. `pause`: removed time no word covers. `untranscribed`: removed time in media with no transcript. Kinds come from the transcript alone, so a retake reworded on the second try counts as speech.
- **Removed words against the reference.** Precision and recall of the words the agent removed, plus how many labelled words both agree on.
- **Edges inside a word.** Source edges the cut added that fall inside a transcribed word, by more than 20 ms or half a frame, whichever is longer. The edges themselves are listed in `results.jsonl`.
- **Pauses at joins.** A join is two neighbouring words the cut brought together, or whose pause it changed. The pause runs from the first word's end to the next word's start, in whole frames. Reported as count, median, 90th percentile, longest, and a distribution over under 0.1 s, 0.25 s, 0.5 s, 1 s and longer. With a reference timeline the same numbers are reported for it, with the pause difference at the joins both cuts made.
- **Time to first edit.** Seconds from the plan's `startedAt` to its first `video_timeline_edit`, when both carry times.

Not measured: picture, audio levels, speed-changed clips' pauses (a pause assumes normal speed), and anything about taste.

## A case

A folder with `case.json` (`CaseFile` in `case.ts` documents every field) and the files it names:

```json
{
  "id": "hook-retake",
  "source": "synthetic",
  "request": "Cut the first take of the hook and the ums.",
  "timeline": "start.otio",
  "timelineName": "timelines/main.otio",
  "transcripts": { "Footage/take-01.mov": "take-01.words.json" },
  "reference": { "timeline": "reference.otio" },
  "plan": "plan.json"
}
```

- `timeline`: the OTIO file the agent started from, as Stellar wrote it (a project's `Stellar/timelines/*.otio`).
- `transcripts`: a words file per media `target_url` on that timeline, in Stellar's `Audio/<clip>.words.json` format: `[{ "w": "hook", "start": 1.4, "end": 1.8 }]`.
- `reference`: the finished cut as an OTIO timeline, or `{ "decisions": "decisions.json" }` for the user's verdicts on the agent's cuts.
- `plan`: the agent's calls, replayed to get the timeline to score. A case with no plan names the timeline the agent left as `result`.

A decisions file lists word ranges of the starting timeline, numbered as `video_timeline_words` numbers them: `kept` (the user kept this cut), `undone` (the user put the words back) or `added` (a cut the user made themselves). Words no decision names are left out of precision and recall unless the file says `"complete": true`.

```json
{
  "decisions": [
    { "fromWord": 1, "toWord": 5, "decision": "kept" },
    { "fromWord": 19, "toWord": 19, "decision": "undone" }
  ]
}
```

To add a case: copy the project's timeline as it was before the agent's turn, its words files, and the reference into a new folder under `$STELLAR_EVAL_DATA/video-cuts/`, then capture or write the plan. Say where the case came from in `source`.

## A plan

`Plan` in `replay.ts`. `fixtures/hook-retake/plan.json` is a hand-written one.

```json
{
  "version": 1,
  "source": { "kind": "hand-written" },
  "startedAt": "2026-01-01T12:00:00.000Z",
  "calls": [
    { "tool": "video_timeline_words", "at": "2026-01-01T12:00:09.000Z", "input": {} },
    {
      "tool": "video_timeline_edit",
      "at": "2026-01-01T12:00:21.000Z",
      "input": {
        "timeline": "timelines/main.otio",
        "edits": [{ "kind": "removeWords", "fromWord": 1, "toWord": 5, "ripple": true }]
      }
    }
  ]
}
```

Capture one from a finished thread. The database is opened read-only; tool results are not copied, so no transcript text travels with a plan.

```sh
pnpm video-cuts:capture --db ~/.t3/userdata/statev2.sqlite --thread <thread id> --out ~/stellar-eval-data/video-cuts/<case id>/plan.json
```

`--run <run id>` keeps one run's calls. Without it the plan holds every completed `video_*` call of the thread.

## What replay does and does not do

Replay applies each `video_timeline_edit` call as the server does: word numbers are read once before the call, and one bad edit refuses the whole call. A refused or skipped call is printed and recorded, and the replay goes on with the next call.

- `replay.ts` mirrors the edit checks of `VideoProjects.editTimeline` in `apps/server`. When that method changes how it resolves an edit, change `resolveEdits` with it.
- Marker and text edits are left out: they change no cut. `restoreVersion` is refused, because a version id names a state of the run's own history.
- `video_voice_over`, `video_footage` and `video_premiere_pull` change a timeline from files a plan does not carry. Their calls are skipped and say so.
- An input this checkout can't read (an edit kind added later) refuses the call. Arguments it doesn't know are dropped.
- Nothing the user did in Premiere between calls is replayed.

## Tests

`score.test.ts` and `replay.test.ts` run on the fixtures and on timelines built in the test. CI runs them.
