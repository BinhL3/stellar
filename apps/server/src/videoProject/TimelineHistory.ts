/**
 * A timeline's versions as the video project service uses them: committing a text, listing and
 * reading versions, and bringing one back. The store itself is `@t3tools/timeline/versions`.
 */
import type {
  VideoTimelineEdits,
  VideoTimelineRestoreResult,
  VideoTimelineReviewEditInput,
  VideoTimelineReviewEditResult,
  VideoTimelineVersion,
  VideoTimelineVersions,
  VideoTimelineVersionView,
} from "@t3tools/contracts";
import { diffSentences, diffTimelines, mergeTimelines } from "@t3tools/timeline/diff";
import { carryChange, frameOfAnchor } from "@t3tools/timeline/editReview";
import { serializeTimeline, type Timeline } from "@t3tools/timeline/otio";
import { pulledHash, readBase } from "@t3tools/timeline/premiereSync";
import {
  decideEdits,
  settleEditsAt,
  hashOfText,
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
  /** An agent's account of the change, which makes it an edit the user reviews. */
  readonly review?: { readonly summary: string; readonly check?: string };
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
    ...(input.review === undefined ? {} : { review: input.review }),
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
  readonly review?: { readonly summary: string; readonly check?: string };
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
    ...(input.review === undefined ? {} : { review: input.review }),
  });
  // The Edits panel and agents read each edit's state off the history: it follows the timeline.
  yield* settleEditsAt({
    projectDir,
    timelinePath,
    targetId: target.id,
    recordedId: recorded.id,
  }).pipe(Effect.mapError(failed(`Could not update the edits of ${timelinePath}.`)));
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

/** `current` is the timeline now, in which each edit's place is found again; null when unreadable. */
const editsOf = (
  timelinePath: string,
  history: TimelineHistory,
  current: Timeline | null,
): VideoTimelineEdits => ({
  timeline: timelinePath,
  edits: history.versions
    .flatMap((version) => {
      const edit = version.edit;
      if (edit === undefined) return [];
      const moved =
        current === null || edit.anchor === undefined || edit.frame === null
          ? null
          : frameOfAnchor(current, edit.anchor, edit.frame);
      return [
        {
          number: edit.number,
          version: version.id,
          before: history.versions.find((candidate) => candidate.id === version.parent)?.id ?? null,
          at: version.at,
          summary: edit.summary,
          check: edit.check ?? null,
          decision: edit.decision ?? null,
          frame: moved ?? edit.frame,
          removed: edit.removed ?? null,
        },
      ];
    })
    .toReversed(),
});

const editsNow = Effect.fn("TimelineHistory.editsNow")(function* (
  projectDir: string,
  timelinePath: string,
) {
  const { current, history } = yield* caughtUp(projectDir, timelinePath);
  const timeline = yield* parse(current, timelinePath).pipe(Effect.orElseSucceed(() => null));
  return editsOf(timelinePath, history, timeline);
});

export const listTimelineEdits = Effect.fn("TimelineHistory.listEdits")(function* (
  projectDir: string,
  timelinePath: string,
) {
  return yield* editsNow(projectDir, timelinePath);
});

const named = (words: ReadonlyArray<string>) =>
  words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

/**
 * What the user decides about one edit. Undo and redo carry just that edit's change onto the
 * timeline as it is now; when a later edit changed the same thing they change nothing and say
 * so in `blocked`. Call it after a merging sync, as a restore is.
 */
export const reviewTimelineEdit = Effect.fn("TimelineHistory.reviewEdit")(function* (
  input: Pick<VideoTimelineReviewEditInput, "edit" | "action"> & {
    readonly projectDir: string;
    readonly timelinePath: string;
  },
) {
  const { projectDir, timelinePath } = input;
  const { current, history } = yield* caughtUp(projectDir, timelinePath);
  const index = history.versions.findIndex((version) => version.edit?.number === input.edit);
  const version = history.versions[index];
  const edit = version?.edit;
  const name = `E${input.edit}`;
  if (version === undefined || edit === undefined) {
    return yield* new TimelineHistoryError({ reason: `${timelinePath} has no edit ${name}.` });
  }
  const decide = (numbers: ReadonlyArray<number>, decision: "kept" | "undone" | null) =>
    decideEdits({ projectDir, timelinePath, numbers, decision }).pipe(
      Effect.mapError(failed(`Could not record the decision on ${name}.`)),
    );
  const done = Effect.fn("TimelineHistory.reviewEdit.done")(function* (
    blocked: string | null = null,
  ) {
    return {
      ...(yield* editsNow(projectDir, timelinePath)),
      blocked,
    } satisfies VideoTimelineReviewEditResult;
  });

  if (input.action === "keep" || input.action === "reopen") {
    // An undone edit is out of the timeline; only putting it back changes that.
    if (edit.decision === "undone") {
      return yield* done(`${name} was undone. Put it back first.`);
    }
    yield* decide([input.edit], input.action === "keep" ? "kept" : null);
    return yield* done();
  }

  const before = history.versions.find((candidate) => candidate.id === version.parent);
  const beforeText =
    before === undefined ? null : yield* readSnapshot(projectDir, timelinePath, before.hash);
  const afterText = yield* readSnapshot(projectDir, timelinePath, version.hash);
  if (before === undefined || beforeText === null || afterText === null) {
    return yield* done(
      `The versions around ${name} are no longer in the history, so it can't be taken out or put back.`,
    );
  }

  if (input.action === "restoreBefore") {
    yield* restoreTimelineVersion({ projectDir, timelinePath, version: before.id, by: "user" });
    yield* decide(
      history.versions.slice(index).flatMap((later) => later.edit?.number ?? []),
      "undone",
    );
    return yield* done();
  }

  const undo = input.action === "undo";
  if (undo === (edit.decision === "undone")) {
    return yield* done(undo ? `${name} is already undone.` : `${name} is in the timeline.`);
  }
  // A pull that brought changes rewrites the whole file, so the versions around the edit no
  // longer line up with it. A pull that only confirmed a push changed nothing and is no bar.
  const pulledChanges = history.versions
    .slice(index + 1)
    .some((later) => later.by === "premiere" && later.changes.length > 0);
  if (version.base !== history.base && pulledChanges) {
    return yield* done(
      `Premiere's save was pulled in after ${name}, so it can't be ${undo ? "taken out" : "put back"} on its own.${undo ? " Restoring the version before it would also take out everything done after it." : ""}`,
    );
  }
  const [from, to] = undo ? [afterText, beforeText] : [beforeText, afterText];
  let text = to;
  // With nothing changed since, the other side of the edit is the exact text to write.
  if (hashOfText(current) !== hashOfText(from)) {
    const carried = carryChange(
      yield* parse(from, `A version around ${name}`),
      yield* parse(to, `A version around ${name}`),
      yield* parse(current, timelinePath),
    );
    if (carried.overlaps.length > 0) {
      return yield* done(
        undo
          ? `${name} can't be undone on its own: changes made since touch what it changed (${named(carried.overlaps)}). Restoring the version before it would also take out everything done after it.`
          : `${name} can't be put back: changes made since touch what it changed (${named(carried.overlaps)}).`,
      );
    }
    text = serializeTimeline(carried.timeline);
  }
  yield* commitTimelineText({
    projectDir,
    timelinePath,
    text,
    by: "user",
    label: `${undo ? "Undid" : "Put back"} ${name}: ${edit.summary}`,
  });
  yield* decide([input.edit], undo ? "undone" : null);
  return yield* done();
});

const editState = (edit: VideoTimelineEdits["edits"][number]) =>
  edit.decision === "kept"
    ? "kept by the user"
    : edit.decision === "undone"
      ? "undone by the user"
      : edit.check === null
        ? "not reviewed"
        : "waiting on the user's check";

/** The edits as an agent reads them, newest first: `E3 v12 undone by the user: summary`. */
export const editsText = (view: VideoTimelineEdits): string =>
  view.edits.length === 0
    ? "No reviewed edits yet."
    : [
        "# edits, newest first · E<n> version state: summary (check: the doubt left for the user)",
        ...view.edits.map(
          (edit) =>
            `E${edit.number} ${edit.version} ${editState(edit)}: ${edit.summary}${edit.check === null ? "" : ` (check: ${edit.check})`}`,
        ),
      ].join("\n");

/** One line for every read of the timeline, so a turn sees what the user sent back; null with no edits. */
export const editsLine = (view: VideoTimelineEdits): string | null => {
  if (view.edits.length === 0) return null;
  const numbers = (state: string) =>
    view.edits
      .filter((edit) => editState(edit) === state)
      .map((edit) => `E${edit.number}`)
      .toReversed();
  const part = (label: string, state: string) =>
    numbers(state).length === 0 ? [] : [`${label}: ${numbers(state).join(", ")}`];
  return [
    `# edits: ${view.edits.length}`,
    ...part("undone by the user", "undone by the user"),
    ...part("kept by the user", "kept by the user"),
    ...part("waiting on the user's check", "waiting on the user's check"),
    'list them with version: "edits"',
  ].join(" · ");
};
