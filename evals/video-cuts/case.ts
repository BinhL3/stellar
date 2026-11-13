/**
 * Cases on disk. A case is a folder with `case.json` and the files it names; real ones live outside
 * the repository, under the directory `STELLAR_EVAL_DATA` names.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import { levelsOf } from "../../packages/timeline/src/levels.ts";
import type { Timeline } from "../../packages/timeline/src/otio.ts";
import { Plan } from "./replay.ts";
import type { CutScore, Reference } from "./score.ts";

/** `case.json`. Files are named relative to the case's folder. */
export const CaseFile = Schema.Struct({
  id: Schema.String,
  /** Where the case came from: a thread, a short, or `synthetic`. */
  source: Schema.String,
  /** What the user asked for, for the person reading the summary. */
  request: Schema.optional(Schema.String),
  /** The OTIO timeline the agent started from. */
  timeline: Schema.String,
  /** That timeline's name in tool calls, such as `timelines/main.otio`. */
  timelineName: Schema.optional(Schema.String),
  /** A `[{ w, start, end }]` words file per media `target_url` on the timeline. */
  transcripts: Schema.Record(Schema.String, Schema.String),
  /**
   * A levels file per media `target_url`, as Stellar keeps beside a transcript
   * (`Audio/<clip>.levels.json`). With one, a replayed word cut lands on measured quiet.
   */
  levels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** The finished cut as an OTIO timeline, or the user's decisions on the agent's cuts. */
  reference: Schema.optional(
    Schema.Union([
      Schema.Struct({ timeline: Schema.String }),
      Schema.Struct({ decisions: Schema.String }),
    ]),
  ),
  /** The agent's edit calls, to replay. */
  plan: Schema.optional(Schema.String),
  /** The timeline the agent left, for a case with no plan. */
  result: Schema.optional(Schema.String),
  /** Hesitation words to count as fillers instead of the built-in list. */
  fillers: Schema.optional(Schema.Array(Schema.String)),
});

const Words = Schema.Array(
  Schema.Struct({ w: Schema.String, start: Schema.Number, end: Schema.Number }),
);
const LevelsFile = Schema.Struct({ step: Schema.Number, db: Schema.Array(Schema.Number) });
const Decisions = Schema.Struct({
  complete: Schema.optional(Schema.Boolean),
  decisions: Schema.Array(
    Schema.Struct({
      fromWord: Schema.Number,
      toWord: Schema.Number,
      decision: Schema.Literals(["kept", "undone", "added"]),
    }),
  ),
});

const REPO = NodePath.resolve(import.meta.dirname, "../..");
const RUNS = NodePath.join(REPO, "evals", "runs");
const within = (directory: string, file: string) => {
  const relative = NodePath.relative(directory, NodePath.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/**
 * Results carry numbers derived from the footage, so they go outside the checkout or under the
 * gitignored `evals/runs`. Scarlet's eval writers refuse checkout paths the same way.
 */
export const assertOutsideRepo = (file: string) => {
  if (within(REPO, file) && !within(RUNS, file)) {
    throw new Error(`${file} is inside the repository. Write under evals/runs or outside it.`);
  }
};

const read = (file: string) => NodeFS.readFileSync(file, "utf8");
const decodeCaseFile = Schema.decodeUnknownSync(Schema.fromJsonString(CaseFile));
const decodeWords = Schema.decodeUnknownSync(Schema.fromJsonString(Words));
const decodeLevels = Schema.decodeUnknownSync(Schema.fromJsonString(LevelsFile));
const decodeDecisions = Schema.decodeUnknownSync(Schema.fromJsonString(Decisions));
const decodePlan = Schema.decodeUnknownSync(Schema.fromJsonString(Plan));

// Stellar reads timelines the same way: the file is trusted to be the OTIO it wrote.
const readTimeline = (file: string) => JSON.parse(read(file)) as Timeline;

export const readPlan = (file: string) => decodePlan(read(file));

export const loadCase = (directory: string) => {
  const at = (file: string) => NodePath.join(directory, file);
  const file = decodeCaseFile(read(at("case.json")));
  const decisions =
    file.reference !== undefined && "decisions" in file.reference
      ? decodeDecisions(read(at(file.reference.decisions)))
      : undefined;
  const reference: Reference | undefined =
    file.reference === undefined
      ? undefined
      : "timeline" in file.reference
        ? { kind: "timeline", timeline: readTimeline(at(file.reference.timeline)) }
        : {
            kind: "decisions",
            decisions: decisions?.decisions ?? [],
            ...(decisions?.complete === undefined ? {} : { complete: decisions.complete }),
          };
  return {
    id: file.id,
    source: file.source,
    timelineName: file.timelineName,
    fillers: file.fillers,
    start: readTimeline(at(file.timeline)),
    transcripts: new Map(
      Object.entries(file.transcripts).map(([media, words]) => [
        media,
        decodeWords(read(at(words))),
      ]),
    ),
    levels: new Map(
      Object.entries(file.levels ?? {}).map(([media, name]) => {
        const { db, step } = decodeLevels(read(at(name)));
        return [media, levelsOf(db, step)];
      }),
    ),
    reference,
    plan: file.plan === undefined ? undefined : readPlan(at(file.plan)),
    result: file.result === undefined ? undefined : readTimeline(at(file.result)),
  };
};
export type LoadedCase = ReturnType<typeof loadCase>;

/** The case folders in `directory`: each one that holds a `case.json`. */
export const caseDirectories = (directory: string) =>
  NodeFS.readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && NodeFS.existsSync(NodePath.join(directory, entry.name, "case.json")),
    )
    .map((entry) => NodePath.join(directory, entry.name))
    .toSorted();

export interface ResultRow {
  readonly id: string;
  readonly score: CutScore;
}

const cell = (value: number | null, was?: number | null) => {
  if (value === null) return "-";
  if (was === undefined || was === null || was === value) return String(value);
  const change = Math.round((value - was) * 1000) / 1000;
  return `${value} (${change > 0 ? "+" : ""}${change})`;
};

/** A table a person reads; with a baseline, each number carries its change from that run. */
export const summarize = (rows: ReadonlyArray<ResultRow>, baseline: ReadonlyArray<ResultRow>) => {
  const before = new Map(baseline.map((row) => [row.id, row.score]));
  const lines = [
    "| case | removed s | retake | filler | speech | pause | precision | recall | edges in a word | joins | median pause s | reference median s | first edit s |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const { id, score } of rows) {
    const was = before.get(id);
    const kind = (name: string) => cell(score.removed.byKind[name] ?? 0, was?.removed.byKind[name]);
    lines.push(
      `| ${[
        id,
        cell(score.removed.seconds, was?.removed.seconds),
        kind("retake"),
        kind("filler"),
        kind("speech"),
        kind("pause"),
        cell(score.words?.precision ?? null, was?.words?.precision),
        cell(score.words?.recall ?? null, was?.words?.recall),
        `${cell(score.edges.insideWord, was?.edges.insideWord)} of ${score.edges.count}`,
        cell(score.joins.count, was?.joins.count),
        cell(score.joins.median, was?.joins.median),
        cell(score.reference?.joins.median ?? null),
        cell(score.timeToFirstEditSeconds, was?.timeToFirstEditSeconds),
      ].join(" | ")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
};
