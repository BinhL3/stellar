#!/usr/bin/env node
// An eval script, not server code: it reads case files and writes results directly.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { serializeTimeline } from "../../packages/timeline/src/otio.ts";
import {
  assertOutsideRepo,
  caseDirectories,
  loadCase,
  readPlan,
  type ResultRow,
  summarize,
} from "./case.ts";
import { replayPlan } from "./replay.ts";
import { scoreCut } from "./score.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    // A directory of case folders. Unset: `$STELLAR_EVAL_DATA/video-cuts`.
    cases: { type: "string" },
    case: { type: "string", multiple: true },
    // Replays this plan instead of the case's own. Needs one --case.
    plan: { type: "string" },
    baseline: { type: "string" },
  },
});
const data = process.env.STELLAR_EVAL_DATA;
const root = values.cases ?? (data ? NodePath.join(data, "video-cuts") : undefined);
if (!values.out || !root) {
  throw new Error(
    "Use --out <directory> [--cases <directory>] [--case <id>] [--plan <file>] [--baseline <results.jsonl>]. Without --cases, set STELLAR_EVAL_DATA.",
  );
}
const out = NodePath.resolve(values.out);
assertOutsideRepo(out);
const wanted = values.case?.flatMap((ids) => ids.split(","));
const selected = caseDirectories(root)
  .map(loadCase)
  .filter((entry) => wanted === undefined || wanted.includes(entry.id));
if (selected.length === 0) throw new Error(`No case in ${root} matches.`);
if (values.plan !== undefined && selected.length !== 1) {
  throw new Error("--plan replays one case: pass one --case.");
}

NodeFS.mkdirSync(out, { recursive: true });
const rows: Array<ResultRow & { readonly [key: string]: unknown }> = [];
for (const entry of selected) {
  const plan = values.plan === undefined ? entry.plan : readPlan(values.plan);
  const replay =
    plan === undefined
      ? undefined
      : replayPlan({
          start: entry.start,
          transcripts: entry.transcripts,
          plan,
          timelineName: entry.timelineName,
        });
  const result = replay?.timeline ?? entry.result;
  if (result === undefined) throw new Error(`${entry.id}: needs a plan or a result timeline.`);
  if (replay !== undefined) {
    NodeFS.writeFileSync(NodePath.join(out, `${entry.id}.otio`), serializeTimeline(result));
  }
  rows.push({
    id: entry.id,
    source: entry.source,
    from: replay === undefined ? "result" : "replay",
    ...(replay === undefined ? {} : { calls: replay.calls }),
    score: scoreCut({
      start: entry.start,
      result,
      transcripts: entry.transcripts,
      reference: entry.reference,
      fillers: entry.fillers,
      log: plan,
    }),
  });
}
const baseline =
  values.baseline === undefined
    ? []
    : NodeFS.readFileSync(values.baseline, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as ResultRow);
const summary = summarize(rows, baseline);
NodeFS.writeFileSync(
  NodePath.join(out, "results.jsonl"),
  rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
);
NodeFS.writeFileSync(NodePath.join(out, "summary.md"), summary);
process.stdout.write(summary);
for (const row of rows) {
  const calls = (row.calls ?? []) as ReadonlyArray<{ status: string; note?: string }>;
  for (const call of calls) {
    if (call.status !== "applied" || call.note !== undefined) {
      process.stdout.write(`${row.id}: call ${call.status}${call.note ? ` (${call.note})` : ""}\n`);
    }
  }
}
