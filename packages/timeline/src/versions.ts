// @effect-diagnostics nodeBuiltinImport:off -- A snapshot is named by the hash of its text.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { diffSentences, diffTimelines } from "./diff.ts";
import { NOWHERE, placeOfChanges } from "./editReview.ts";
import { serializeJson, type Timeline } from "./otio.ts";

/**
 * A timeline's history: every text its file has held, each stored once under its hash in
 * `timelines/.history/<file>/`, and an index beside it saying who wrote each and what changed.
 * The text last read from Premiere (what a merge starts from) is a snapshot in the same store.
 */
export const HISTORY_DIRECTORY = "timelines/.history";

const VersionAuthor = Schema.Literals(["user", "agent", "premiere", "outside"]);
/** `outside` is a change no tool of ours made: the file was edited by hand or by another program. */
export type VersionAuthor = typeof VersionAuthor.Type;

const FrameSpan = Schema.Struct({ start: Schema.Number, end: Schema.Number });

/** An agent's edit as the user reviews it: what it says it did, and what the user decided. */
const VersionEdit = Schema.Struct({
  /** Counted up per timeline and never reused; the user and the agent both say `E<n>`. */
  number: Schema.Number,
  summary: Schema.String,
  /** A doubt only watching or listening settles. */
  check: Schema.optional(Schema.String),
  decision: Schema.optional(Schema.Literals(["kept", "undone"])),
  /** Where it changed the timeline, in this version's frames. */
  frame: Schema.NullOr(Schema.Number),
  /** The first stretch it took out, in the frames of the version before. */
  removed: Schema.optional(FrameSpan),
  /** The footage at `frame`, by which the place is found again after later changes. */
  anchor: Schema.optional(
    Schema.Struct({ track: Schema.String, target: Schema.String, seconds: Schema.Number }),
  ),
});
export type VersionEdit = typeof VersionEdit.Type;

const TimelineVersion = Schema.Struct({
  /** `v<n>`, counted up per timeline and never reused. */
  id: Schema.String,
  at: Schema.Number,
  by: VersionAuthor,
  label: Schema.String,
  /** What changed from the version before, a sentence each. */
  changes: Schema.Array(Schema.String),
  hash: Schema.String,
  /** Hash of Premiere's save this version was made on; null when no Premiere project is linked. */
  base: Schema.NullOr(Schema.String),
  /** The version undo goes to from here. */
  parent: Schema.NullOr(Schema.String),
  /** Set on a version an undo made: the version redo goes back to. */
  redo: Schema.optional(Schema.String),
  edit: Schema.optional(VersionEdit),
});
export type TimelineVersion = typeof TimelineVersion.Type;

const HistoryIndex = Schema.Struct({
  version: Schema.Literal(1),
  next: Schema.Number,
  /** The number the next reviewed edit takes; absent until there is one. */
  nextEdit: Schema.optional(Schema.Number),
  /** Hash of the text last read from Premiere for this timeline. */
  base: Schema.NullOr(Schema.String),
  /** Oldest first. */
  versions: Schema.Array(TimelineVersion),
});
export type TimelineHistory = typeof HistoryIndex.Type;

const EMPTY: TimelineHistory = { version: 1, next: 1, base: null, versions: [] };
const decodeIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(HistoryIndex));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const hashOfText = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

/** The newest versions are all kept; older ones thin out to the last of each day. */
export const RETAIN_RECENT = 50;
export const RETAIN_DAYS = 30;
const DAY_MS = 86_400_000;
const CHANGES_KEPT = 30;

/**
 * The versions worth keeping: the newest `RETAIN_RECENT`, then the last version of each earlier
 * day for `RETAIN_DAYS` such days. A long session keeps every step of today's work; last month
 * keeps where each day ended.
 */
export const retainVersions = (
  versions: ReadonlyArray<TimelineVersion>,
): ReadonlyArray<TimelineVersion> => {
  if (versions.length <= RETAIN_RECENT) return versions;
  const older = versions.slice(0, -RETAIN_RECENT);
  const lastOfDay = new Map<number, TimelineVersion>();
  for (const version of older) lastOfDay.set(Math.floor(version.at / DAY_MS), version);
  const days = [...lastOfDay.keys()].toSorted((a, b) => b - a).slice(0, RETAIN_DAYS);
  const kept = new Set(days.map((day) => lastOfDay.get(day)));
  return [...older.filter((version) => kept.has(version)), ...versions.slice(-RETAIN_RECENT)];
};

/** Where undo and redo go from the newest version; null when there is nowhere to go. */
export const historySteps = (
  history: TimelineHistory,
): { readonly undo: string | null; readonly redo: string | null } => {
  const head = history.versions.at(-1);
  const has = (id: string | null | undefined) =>
    id !== null && id !== undefined && history.versions.some((version) => version.id === id);
  return {
    undo: head !== undefined && has(head.parent) ? head.parent : null,
    redo: head?.redo !== undefined && has(head.redo) ? head.redo : null,
  };
};

const paths = Effect.fn("timeline.versions.paths")(function* (
  projectDir: string,
  timelinePath: string,
) {
  const path = yield* Path.Path;
  const name = path.basename(timelinePath);
  const folder = path.join(projectDir, HISTORY_DIRECTORY, name);
  return {
    folder,
    index: path.join(projectDir, HISTORY_DIRECTORY, `${name}.json`),
    snapshot: (hash: string) => path.join(folder, `${hash}.otio`),
  };
});

/** `timelinePath` is relative to the project folder. A timeline with no history reads as empty. */
export const readHistory = Effect.fn("timeline.readHistory")(function* (
  projectDir: string,
  timelinePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* paths(projectDir, timelinePath);
  return yield* fs.readFileString(files.index).pipe(
    Effect.flatMap(decodeIndex),
    Effect.orElseSucceed(() => EMPTY),
  );
});

/** A snapshot's text, or null when the store doesn't hold it. */
export const readSnapshot = Effect.fn("timeline.readSnapshot")(function* (
  projectDir: string,
  timelinePath: string,
  hash: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* paths(projectDir, timelinePath);
  return yield* fs.readFileString(files.snapshot(hash)).pipe(Effect.orElseSucceed(() => null));
});

export const hasSnapshot = Effect.fn("timeline.hasSnapshot")(function* (
  projectDir: string,
  timelinePath: string,
  hash: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* paths(projectDir, timelinePath);
  return yield* fs.exists(files.snapshot(hash)).pipe(Effect.orElseSucceed(() => false));
});

const writeIndex = Effect.fn("timeline.versions.writeIndex")(function* (
  file: string,
  history: TimelineHistory,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(file, serializeJson(history));
});

/**
 * Keeps `text` as what Premiere last saved for this timeline. It is what the edits made here
 * are told apart from, so it stays in the store while it is the latest or a kept version was
 * made on it.
 */
export const keepBase = Effect.fn("timeline.keepBase")(function* (input: {
  readonly projectDir: string;
  readonly timelinePath: string;
  readonly text: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* paths(input.projectDir, input.timelinePath);
  const hash = hashOfText(input.text);
  yield* fs.makeDirectory(files.folder, { recursive: true });
  yield* fs.writeFileString(files.snapshot(hash), input.text);
  const history = yield* readHistory(input.projectDir, input.timelinePath);
  if (history.base !== hash) yield* writeIndex(files.index, { ...history, base: hash });
});

/**
 * What changed between two texts of a timeline, as sentences and as a place; nothing when
 * either can't be read as one, or is JSON the diff can't lay out.
 */
const changesBetween = Effect.fn("timeline.versions.changesBetween")(
  function* (before: string, after: string) {
    const from = (yield* decodeJson(before)) as Timeline;
    const to = (yield* decodeJson(after)) as Timeline;
    const diff = yield* Effect.try({
      try: () => diffTimelines(from, to),
      catch: () => "not a timeline the diff can lay out" as const,
    });
    const sentences = diffSentences(diff);
    return {
      sentences:
        sentences.length <= CHANGES_KEPT
          ? sentences
          : [...sentences.slice(0, CHANGES_KEPT), `and ${sentences.length - CHANGES_KEPT} more`],
      place: placeOfChanges(diff.changes, from, to),
    };
  },
  Effect.orElseSucceed(() => ({ sentences: [] as ReadonlyArray<string>, place: NOWHERE })),
);

/**
 * Records that the timeline's file now holds `text`. `before` is what the file held until now:
 * when the history doesn't end there, the file was changed by something that recorded nothing,
 * and that text is recorded first so no state is lost. Recording the text the history already
 * ends on adds nothing. Returns the newest version.
 */
export const recordVersion = Effect.fn("timeline.recordVersion")(function* (input: {
  readonly projectDir: string;
  readonly timelinePath: string;
  readonly text: string;
  readonly before?: string;
  readonly by: VersionAuthor;
  readonly label: string;
  /** For an undo or redo: where undo and redo go from the new version. */
  readonly steps?: { readonly parent: string | null; readonly redo?: string };
  /** Makes the version an edit the user reviews. */
  readonly review?: { readonly summary: string; readonly check?: string };
}) {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* paths(input.projectDir, input.timelinePath);
  const history = yield* readHistory(input.projectDir, input.timelinePath);
  const now = yield* Clock.currentTimeMillis;
  yield* fs.makeDirectory(files.folder, { recursive: true });

  const versions = [...history.versions];
  let next = history.next;
  let nextEdit = history.nextEdit ?? 1;
  const add = Effect.fn("timeline.versions.add")(function* (
    text: string,
    by: VersionAuthor,
    label: string,
    steps: { readonly parent: string | null; readonly redo?: string } | undefined,
    review?: { readonly summary: string; readonly check?: string },
  ) {
    const head = versions.at(-1);
    const previous =
      head === undefined
        ? null
        : yield* fs
            .readFileString(files.snapshot(head.hash))
            .pipe(Effect.orElseSucceed(() => null));
    const hash = hashOfText(text);
    yield* fs.writeFileString(files.snapshot(hash), text);
    const changed =
      previous === null ? { sentences: [], place: NOWHERE } : yield* changesBetween(previous, text);
    const version: TimelineVersion = {
      id: `v${next}`,
      at: now,
      by,
      label,
      changes: changed.sentences,
      hash,
      base: history.base,
      parent: steps === undefined ? (head?.id ?? null) : steps.parent,
      ...(steps?.redo === undefined ? {} : { redo: steps.redo }),
      ...(review === undefined
        ? {}
        : {
            edit: {
              number: nextEdit,
              summary: review.summary,
              ...(review.check === undefined ? {} : { check: review.check }),
              frame: changed.place.frame,
              ...(changed.place.removed === null ? {} : { removed: changed.place.removed }),
              ...(changed.place.anchor === null ? {} : { anchor: changed.place.anchor }),
            },
          }),
    };
    if (review !== undefined) nextEdit += 1;
    versions.push(version);
    next += 1;
    return version;
  });

  if (input.before !== undefined && versions.at(-1)?.hash !== hashOfText(input.before)) {
    yield* add(
      input.before,
      "outside",
      versions.length === 0 ? "Where this history starts" : "Changed outside Stellar",
      undefined,
    );
  }
  const head = versions.at(-1);
  if (head !== undefined && head.hash === hashOfText(input.text)) {
    if (versions.length !== history.versions.length) {
      yield* writeIndex(files.index, { ...history, next, versions });
    }
    return head;
  }
  const added = yield* add(input.text, input.by, input.label, input.steps, input.review);

  const kept = retainVersions(versions);
  yield* writeIndex(files.index, {
    ...history,
    next,
    ...(nextEdit === 1 ? {} : { nextEdit }),
    versions: kept,
  });
  const needed = new Set<string | null>([
    history.base,
    ...kept.flatMap((version) => [version.hash, version.base]),
  ]);
  const stored = yield* fs
    .readDirectory(files.folder)
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  for (const name of stored) {
    const hash = name.endsWith(".otio") ? name.slice(0, -".otio".length) : null;
    if (hash === null || needed.has(hash)) continue;
    yield* fs.remove(files.snapshot(hash)).pipe(Effect.ignore);
  }
  return added;
});

/** Records what the user decided about edits; `null` puts one back to undecided. */
export const decideEdits = Effect.fn("timeline.decideEdits")(function* (input: {
  readonly projectDir: string;
  readonly timelinePath: string;
  readonly numbers: ReadonlyArray<number>;
  readonly decision: "kept" | "undone" | null;
}) {
  const files = yield* paths(input.projectDir, input.timelinePath);
  const history = yield* readHistory(input.projectDir, input.timelinePath);
  const versions = history.versions.map((version) => {
    if (version.edit === undefined || !input.numbers.includes(version.edit.number)) return version;
    const { decision: _decision, ...edit } = version.edit;
    return {
      ...version,
      edit: input.decision === null ? edit : { ...edit, decision: input.decision },
    };
  });
  const decided = { ...history, versions };
  yield* writeIndex(files.index, decided);
  return decided;
});
