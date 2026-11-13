#!/usr/bin/env node
// Reads a Stellar database read-only and writes a plan: one thread's video tool calls.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

import { assertOutsideRepo } from "./case.ts";
import { planFromTurnItems } from "./replay.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    // A `statev2.sqlite`. It is opened read-only and never written.
    db: { type: "string" },
    thread: { type: "string" },
    // One run of the thread, by run id. Unset: every run.
    run: { type: "string" },
    out: { type: "string" },
  },
});
if (!values.db || !values.thread || !values.out) {
  throw new Error("Use --db <statev2.sqlite> --thread <thread id> --out <plan.json> [--run <id>].");
}
const out = NodePath.resolve(values.out);
assertOutsideRepo(out);

const database = new NodeSqlite.DatabaseSync(values.db, { readOnly: true });
const items = database
  .prepare(
    "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ? AND type = 'dynamic_tool' ORDER BY ordinal, turn_item_id",
  )
  .all(values.thread)
  .map((row) => JSON.parse(String(row.payload_json)) as unknown);
const runStarts = new Map(
  database
    .prepare(
      "SELECT run_id, requested_at FROM orchestration_v2_projection_runs WHERE thread_id = ?",
    )
    .all(values.thread)
    .map((row) => [String(row.run_id), String(row.requested_at)] as const),
);
database.close();

const plan = planFromTurnItems({ threadId: values.thread, items, runStarts, runId: values.run });
NodeFS.mkdirSync(NodePath.dirname(out), { recursive: true });
NodeFS.writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
const edits = plan.calls.filter((call) => call.tool === "video_timeline_edit").length;
process.stdout.write(`${out}: ${plan.calls.length} video tool calls, ${edits} of them edits\n`);
