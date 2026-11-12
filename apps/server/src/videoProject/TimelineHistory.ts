/**
 * A timeline's versions as the video project service uses them: committing a text, listing and
 * reading versions, and bringing one back. The store itself is `@t3tools/timeline/versions`.
 */
import type {
  VideoTimelineRestoreResult,
  VideoTimelineVersion,
  VideoTimelineVersions,
  VideoTimelineVersionView,
} from "@t3tools/contracts";
import { diffSentences, diffTimelines, mergeTimelines } from "@t3tools/timeline/diff";
import { serializeTimeline, type Timeline } from "@t3tools/timeline/otio";
import { pulledHash, readBase } from "@t3tools/timeline/premiereSync";
import {
  historySteps,
  readHistory,
  readSnapshot,
  recordVersion,
  type TimelineHistory,
  type TimelineVersion,
  type VersionAuthor,
} from "@t3tools/timeline/versions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class TimelineHistoryError extends Schema.TaggedError<TimelineHistoryError>()(
  "TimelineHistoryError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const parse = (text: string, what: string) =>
  decodeJson(text).pipe(
    Effect.flatMap((value) => {
      const timeline = value as Partial<Timeline> | null;
      return timeline?.OTIO_SCHEMA === "Timeline.1" && Array.isArray(timeline.tracks?.children)
        ? Effect.succeed(timeline as Timeline)
        : Effect.fail(new TimelineHistoryError({ reason: `${what} is not a timeline.` }));
    }),
    Effect.catchTags({
      SchemaError: (cause) =>
        Effect.fail(new TimelineHistoryError({ reason: `${what} is not a timeline.`, cause })),
    }),
  );

const failed = (reason: string) => (cause: unknown) => new TimelineHistoryError({ reason, cause });

const publicVersion = (version: TimelineVersion): VideoTimelineVersion => ({
  id: version.id,
  at: version.at,
  by: version.by,
  label: version.label,
  changes: version.changes,
});

const viewOf = (timelinePath: string, history: TimelineHistory): VideoTimelineVersions => ({
  timeline: timelinePath,
  versions: history.versions.toReversed().map(publicVersion),
  ...historySteps(history),
});

// The diff throws on a text that is JSON but not a timeline it can lay out.
const sentences = (from: Timeline, to: Timeline): ReadonlyArray<string> => {
  try {
    return diffSentences(diffTimelines(from, to));
  } catch {
    return [];
  }
};

/**
 * The history as it stands, with the file's present text recorded first if nothing recorded it:
 * a version list must end on what the file holds, or undo would step from the wrong place.
 */
const caughtUp = Effect.fn("TimelineHistory.caughtUp")(function* (
  projectDir: string,
  timelinePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = yield* fs
    .readFileString(path.join(projectDir, timelinePath))
    .pipe(Effect.mapError(failed(`Could not read ${timelinePath}.`)));
  yield* recordVersion({
    projectDir,
    timelinePath,
    text: current,
    before: current,
    by: "outside",
    label: "Changed outside Stellar",
  }).pipe(Effect.mapError(failed(`Could not record the history of ${timelinePath}.`)));
  return { current, history: yield* readHistory(projectDir, timelinePath) };
});

/** Writes `text` as the timeline and records it as a version by `by`. */
export const commitTimelineText = Effect.fn("TimelineHistory.commit")(function* (input: {
  readonly projectDir: string;
  readonly timelinePath: string;
  readonly text: string;
  readonly by: VersionAuthor;
  readonly label: string;
  readonly steps?: { readonly parent: string | null; readonly redo?: string };
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(input.projectDir, input.timelinePath);
  const before = yield* fs.readFileString(file).pipe(Effect.option);
  yield* fs
    .writeFileString(file, input.text)
    .pipe(Effect.mapError(failed(`Could not write ${input.timelinePath}.`)));
  return yield* recordVersion({
    projectDir: input.projectDir,
    timelinePath: input.timelinePath,
    text: input.text,
    ...(before._tag === "Some" ? { before: before.value } : {}),
    by: input.by,
    label: input.label,
    ...(input.steps === undefined ? {} : { steps: input.steps }),
  }).pipe(Effect.mapError(failed(`Could not record the history of ${input.timelinePath}.`)));
});

/** A commit from a client: the text must be a timeline before it replaces one. */
export const commitFromClient = Effect.fn("TimelineHistory.commitFromClient")(function* (input: {
  readonly projectDir: string;
  readonly timelinePath: string;
  readonly contents: string;
}) {
  yield* parse(input.contents, "What was sent");
  yield* commitTimelineText({
    projectDir: input.projectDir,
    timelinePath: input.timelinePath,
    text: input.contents,
    by: "user",
    label: "Committed in the Timeline tab",
  });
  return viewOf(input.timelinePath, yield* readHistory(input.projectDir, input.timelinePath));
});

export const listTimelineVersions = Effect.fn("TimelineHistory.list")(function* (
  projectDir: string,
  timelinePath: string,
) {
  const { history } = yield* caughtUp(projectDir, timelinePath);
  return viewOf(timelinePath, history);
});

const NO_VERSION = (timelinePath: string, id: string, history: TimelineHistory) =>
  new TimelineHistoryError({
    reason: `${timelinePath} has no version ${id}. It has ${history.versions.map((version) => version.id).join(", ") || "none"}.`,
  });

/** One version's text, and what changed from it to the timeline now. */
export const readTimelineVersion = Effect.fn("TimelineHistory.read")(function* (
  projectDir: string,
  timelinePath: string,
  id: string,
) {
  const { current, history } = yield* caughtUp(projectDir, timelinePath);
  const version = history.versions.find((candidate) => candidate.id === id);
  if (version === undefined) return yield* NO_VERSION(timelinePath, id, history);
  const contents = yield* readSnapshot(projectDir, timelinePath, version.hash);
  if (contents === null) {
    return yield* new TimelineHistoryError({
      reason: `The text of ${id} is no longer in the history folder.`,
    });
  }
  const then = yield* parse(contents, `Version ${id}`);
  const now = yield* parse(current, timelinePath);
  return {
    version: publicVersion(version),
    contents,
    changesSince: sentences(then, now),
    timeline: then,
    current: now,
  } satisfies VideoTimelineVersionView & { timeline: Timeline; current: Timeline };
});

/**
 * Brings a version back as a new version, so a restore can itself be stepped back from. A
 * version made on an earlier Premiere save has its edits re-applied on the latest save, not its
 * text written over it: what changed in Premiere since stays. Call it after a merging sync.
 */
export const restoreTimelineVersion = Effect.fn("TimelineHistory.restore")(function* (input: {
  readonly projectDir: string;
  readonly timelinePath: string;
  readonly version?: string;
  readonly step?: "undo" | "redo";
  readonly by: VersionAuthor;
}) {
  const { projectDir, timelinePath } = input;
  const { history } = yield* caughtUp(projectDir, timelinePath);
  const head = history.versions.at(-1);
  const steps = historySteps(history);
  const id =
    input.step === "undo" ? steps.undo : input.step === "redo" ? steps.redo : input.version;
  if (id === null || id === undefined || head === undefined) {
    return yield* new TimelineHistoryError({
      reason:
        input.step === undefined
          ? "Restoring needs a version."
          : `Nothing to ${input.step}: ${timelinePath} has no ${input.step === "undo" ? "earlier" : "later"} version to step to.`,
    });
  }
  const target = history.versions.find((candidate) => candidate.id === id);
  if (target === undefined) return yield* NO_VERSION(timelinePath, id, history);
  const text = yield* readSnapshot(projectDir, timelinePath, target.hash);
  if (text === null) {
    return yield* new TimelineHistoryError({
      reason: `The text of ${id} is no longer in the history folder.`,
    });
  }

  let restored = text;
  let conflicts: ReadonlyArray<string> = [];
  let keptFromPremiere: ReadonlyArray<string> = [];
  const pulled = yield* pulledHash(projectDir, timelinePath);
  if (pulled !== null && target.base !== null && target.base !== pulled) {
    const then = yield* readBase(projectDir, timelinePath, target.base);
    const now = yield* readBase(projectDir, timelinePath, pulled);
    if (then === null || now === null) {
      return yield* new TimelineHistoryError({
        reason: `${id} was made on an earlier save from Premiere that is no longer on record, so it can't be brought back without discarding what changed in Premiere since. Nothing was changed.`,
      });
    }
    const version = yield* parse(text, `Version ${id}`);
    const merged = yield* Effect.try({
      try: () => mergeTimelines(then, version, now),
      catch: failed(`Could not bring ${id} back onto Premiere's latest save.`),
    });
    restored = serializeTimeline(merged.timeline);
    conflicts = merged.conflicts.map((conflict) => conflict.message);
    keptFromPremiere = sentences(then, now);
  }

  const recorded = yield* commitTimelineText({
    projectDir,
    timelinePath,
    text: restored,
    by: input.by,
    label:
      input.step === "undo"
        ? `Undo: back to ${id}`
        : input.step === "redo"
          ? `Redo: forward to ${id}`
          : `Restored ${id}`,
    ...(input.step === "undo"
      ? { steps: { parent: target.parent, redo: head.id } }
      : input.step === "redo"
        ? {
            steps: {
              parent: target.parent,
              ...(target.redo === undefined ? {} : { redo: target.redo }),
            },
          }
        : {}),
  });
  return {
    ...viewOf(timelinePath, yield* readHistory(projectDir, timelinePath)),
    restored: publicVersion(target),
    recorded: recorded.id,
    keptFromPremiere,
    conflicts,
  } satisfies VideoTimelineRestoreResult & { recorded: string };
});

const stamp = (at: number) =>
  `${DateTime.formatIso(DateTime.makeUnsafe(at)).slice(0, 16).replace("T", " ")}Z`;

/** The versions as an agent reads them, newest first: `v12 2026-11-11 14:02Z agent Label: changes`. */
export const versionsText = (view: VideoTimelineVersions): string =>
  view.versions.length === 0
    ? "No versions yet."
    : [
        "# versions, newest first · id time by label: what changed from the version before",
        ...view.versions.map((version) => {
          const changes =
            version.changes.length === 0
              ? ""
              : `: ${version.changes.slice(0, 3).join("; ")}${version.changes.length > 3 ? `; +${version.changes.length - 3} more` : ""}`;
          return `${version.id} ${stamp(version.at)} ${version.by} ${version.label}${changes}`;
        }),
      ].join("\n");
