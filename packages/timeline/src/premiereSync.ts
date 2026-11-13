// @effect-diagnostics nodeBuiltinImport:off -- Hashing timeline text to tell whose version a file holds.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { diffTimelines, type MergeConflict, mergeTimelines, type TimelineDiff } from "./diff.ts";
import { serializeJson, serializeTimeline, TIMELINE_NAMESPACE, type Timeline } from "./otio.ts";
import { parsePrproj } from "./premiere/prproj.ts";
import { BASE_DIRECTORY, timelineFileName, writeBase, writeBlobs } from "./pullToProject.ts";
import { hasSnapshot, readSnapshot, recordVersion } from "./versions.ts";

/**
 * Which Premiere project a Stellar project follows, and whose version each timeline holds.
 * A `.prproj` only changes when Premiere saves, so its size and modified time say whether there
 * is anything new to pull without opening it.
 */
export const PREMIERE_LINK_PATH = "premiere.json";

interface LinkedTimeline {
  readonly sequenceId: string;
  /** Hash of the text last written from Premiere; the file differing from it means edits here. */
  readonly pulled: string;
  /** Hash of what Premiere's latest save reads as; differing from `pulled` means edits there. */
  readonly premiere: string;
}

interface PremiereLink {
  readonly version: 1;
  readonly project: string;
  readonly saved: { readonly size: number; readonly modified: number } | null;
  /** By timeline path relative to the project folder. */
  readonly timelines: Readonly<Record<string, LinkedTimeline>>;
  /**
   * Name by id of every sequence in the save last read, so one made, renamed or deleted in
   * Premiere since shows. Absent until a save has been read with this known.
   */
  readonly sequences?: Readonly<Record<string, string>>;
}

export type PremiereSyncState =
  /** The timelines hold Premiere's latest save. */
  | "current"
  /** This sync just pulled a newer save. */
  | "updated"
  /** A timeline was edited here; Premiere hasn't changed since. */
  | "edited"
  /** A timeline was edited here and Premiere saved a different version. */
  | "conflict"
  /** The Premiere project can't be read: its drive is unplugged, or it moved. */
  | "offline"
  /** No Premiere project is known for this folder. */
  | "unlinked";

export interface PremiereSyncResult {
  readonly state: PremiereSyncState;
  /** When Premiere last saved the project, in epoch milliseconds. */
  readonly premiereSavedAt: number | null;
  /** Timelines this sync rewrote from Premiere. */
  readonly updated: ReadonlyArray<string>;
  /** Timelines that differ from Premiere's save: left alone, or merged and still holding edits. */
  readonly kept: ReadonlyArray<string>;
  /** What this sync brought in from Premiere, per timeline it rewrote. */
  readonly changes: ReadonlyArray<TimelineChanges>;
  /** Edits made here that aren't in Premiere yet. Absent for a timeline with no base on record. */
  readonly pending: ReadonlyArray<TimelineChanges>;
  /** Edits made here that a merge dropped because Premiere changed the same thing. */
  readonly conflicts: ReadonlyArray<{
    readonly timelinePath: string;
    readonly conflicts: ReadonlyArray<MergeConflict>;
  }>;
  /** Sequences made, renamed or deleted in Premiere since the save last read. */
  readonly sequences: ReadonlyArray<SequenceChange>;
  /** Timelines a merge was asked for and refused: nothing on record says what both started from. */
  readonly unmerged: ReadonlyArray<string>;
}

export interface TimelineChanges {
  readonly timelinePath: string;
  readonly diff: TimelineDiff;
}

export type SequenceChange =
  /** `timelinePath` is null when it could not be pulled: unreadable, or its file name is taken. */
  | { readonly kind: "added"; readonly name: string; readonly timelinePath: string | null }
  | {
      readonly kind: "renamed";
      readonly before: string;
      readonly name: string;
      readonly timelinePath: string;
    }
  /** The timeline here is kept; it just stops following Premiere. */
  | { readonly kind: "removed"; readonly name: string; readonly timelinePath: string };

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const sha = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
// Never equals a real hash, so a timeline whose history is unknown is never silently replaced.
const UNKNOWN = "";

/** The reader throws on files it can't make sense of; here that just means "nothing to pull". */
const attempt = <A>(read: () => A): A | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

const readLink = Effect.fn("timeline.premiereSync.readLink")(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(projectDir, PREMIERE_LINK_PATH)).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((value) => ((value as PremiereLink).version === 1 ? (value as PremiereLink) : null)),
    Effect.orElseSucceed(() => null),
  );
});

const readTimeline = Effect.fn("timeline.premiereSync.readTimeline")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file);
  return { text, timeline: (yield* decodeJson(text)) as Timeline };
});

/**
 * What both sides started from: the snapshot the history keeps under the hash last pulled, or
 * for a project pulled before that, the copy in `timelines/.base`. Null when neither holds it.
 */
export const readBase = Effect.fn("timeline.premiereSync.readBase")(function* (
  projectDir: string,
  timelinePath: string,
  pulled: string,
) {
  const path = yield* Path.Path;
  const kept = yield* readSnapshot(projectDir, timelinePath, pulled);
  if (kept !== null) {
    const timeline = yield* decodeJson(kept).pipe(Effect.option);
    if (Option.isSome(timeline)) return timeline.value as Timeline;
  }
  const read = yield* readTimeline(
    path.join(projectDir, BASE_DIRECTORY, path.basename(timelinePath)),
  ).pipe(Effect.option);
  return Option.isSome(read) && sha(read.value.text) === pulled ? read.value.timeline : null;
});

/** The hash of the text last pulled from Premiere for a timeline, or null when it follows none. */
export const pulledHash = Effect.fn("timeline.premiereSync.pulledHash")(function* (
  projectDir: string,
  timelinePath: string,
) {
  const link = yield* readLink(projectDir);
  const pulled = link?.timelines[timelinePath]?.pulled;
  return pulled === undefined || pulled === UNKNOWN ? null : pulled;
});

const mediaRootOf = (timeline: Timeline) =>
  (timeline.metadata[TIMELINE_NAMESPACE] as { mediaRoot?: string } | undefined)?.mediaRoot;

/**
 * Projects pulled before links were recorded: the Stellar folder sits in the media root, and the
 * Premiere project is that root's only `.prproj`, directly or in a "Premiere" subfolder.
 */
const inferLink = Effect.fn("timeline.premiereSync.inferLink")(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const timelineDir = path.join(projectDir, "timelines");
  const files = yield* fs
    .readDirectory(timelineDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  const timelines: Record<string, LinkedTimeline> = {};
  let mediaRoot: string | undefined;
  for (const file of files.filter((name) => name.endsWith(".otio"))) {
    const read = yield* readTimeline(path.join(timelineDir, file)).pipe(Effect.option);
    if (Option.isNone(read)) continue;
    const sequenceId = (read.value.timeline.metadata["premiere"] as { sequenceId?: string })
      ?.sequenceId;
    if (sequenceId === undefined) continue;
    mediaRoot ??= mediaRootOf(read.value.timeline);
    timelines[`timelines/${file}`] = { sequenceId, pulled: UNKNOWN, premiere: UNKNOWN };
  }
  if (Object.keys(timelines).length === 0) return null;
  const root = mediaRoot ?? path.dirname(projectDir);
  const folders = [root];
  for (const name of yield* fs
    .readDirectory(root)
    .pipe(Effect.orElseSucceed((): Array<string> => []))) {
    if (/premiere/i.test(name)) folders.push(path.join(root, name));
  }
  const candidates: Array<string> = [];
  for (const folder of folders) {
    const names = yield* fs
      .readDirectory(folder)
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    for (const name of names) {
      // macOS writes "._name" resource-fork companions on exFAT drives.
      if (name.toLowerCase().endsWith(".prproj") && !name.startsWith("._")) {
        candidates.push(path.join(folder, name));
      }
    }
  }
  const [project] = candidates;
  if (project === undefined || candidates.length > 1) return null;
  return { version: 1, project, saved: null, timelines } satisfies PremiereLink;
});

/** Records that a timeline now holds what a pull just read from a Premiere project. */
export const recordPull = Effect.fn("timeline.recordPull")(function* (input: {
  readonly projectDir: string;
  readonly premiereProject: string;
  /** Relative to the project folder. */
  readonly timelinePath: string;
  readonly sequenceId: string;
  readonly text: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const existing = yield* readLink(input.projectDir);
  // Following a different Premiere project starts over; the old one's timelines aren't its.
  const kept = existing?.project === input.premiereProject ? existing : null;
  const hash = sha(input.text);
  const link: PremiereLink = {
    version: 1,
    project: input.premiereProject,
    // The other timelines haven't been compared with this save, so the next sync reads it.
    saved: null,
    timelines: {
      ...kept?.timelines,
      [input.timelinePath]: { sequenceId: input.sequenceId, pulled: hash, premiere: hash },
    },
    ...(kept?.sequences === undefined ? {} : { sequences: kept.sequences }),
  };
  yield* writeBase(input);
  yield* fs.writeFileString(path.join(input.projectDir, PREMIERE_LINK_PATH), serializeJson(link));
});

/**
 * Brings timelines up to Premiere's latest save; an unchanged save costs one `stat`. One edited
 * here is only overwritten by `usePremiere`, or by `merge`, which re-applies the edits made here
 * on Premiere's save. Every rewrite is a version in the timeline's history, and so is the text
 * it replaced.
 */
export const syncFromPremiere = Effect.fn("timeline.syncFromPremiere")(function* (input: {
  readonly projectDir: string;
  readonly usePremiere?: boolean;
  readonly merge?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const none = (
    state: PremiereSyncState,
    premiereSavedAt: number | null = null,
  ): PremiereSyncResult => ({
    state,
    premiereSavedAt,
    updated: [],
    kept: [],
    changes: [],
    pending: [],
    conflicts: [],
    sequences: [],
    unmerged: [],
  });
  const link: PremiereLink | null =
    (yield* readLink(input.projectDir)) ?? (yield* inferLink(input.projectDir));
  if (link === null) return none("unlinked");
  const stat = yield* fs.stat(link.project).pipe(Effect.option);
  if (Option.isNone(stat)) return none("offline");
  const saved = {
    size: Number(stat.value.size),
    modified: Option.match(stat.value.mtime, { onNone: () => 0, onSome: (d) => d.getTime() }),
  };

  const local = new Map<
    string,
    { readonly text: string; readonly timeline: Timeline; readonly hash: string }
  >();
  for (const timelinePath of Object.keys(link.timelines)) {
    const read = yield* readTimeline(path.join(input.projectDir, timelinePath)).pipe(Effect.option);
    if (Option.isSome(read)) local.set(timelinePath, { ...read.value, hash: sha(read.value.text) });
  }

  const unchanged =
    link.saved !== null && link.saved.size === saved.size && link.saved.modified === saved.modified;
  // A conflict found by an earlier sync is merged from the same save, which must be read again.
  const mergeRemembered =
    input.merge === true &&
    Object.entries(link.timelines).some(([timelinePath, entry]) => {
      const mine = local.get(timelinePath);
      return mine !== undefined && mine.hash !== entry.pulled && entry.premiere !== entry.pulled;
    });
  const timelines: Record<string, LinkedTimeline> = {};
  let sequences = link.sequences;
  const updated: Array<string> = [];
  const kept: Array<string> = [];
  const changes: Array<TimelineChanges> = [];
  const pending: Array<TimelineChanges> = [];
  const conflicts: Array<PremiereSyncResult["conflicts"][number]> = [];
  const sequenceChanges: Array<SequenceChange> = [];
  const unmerged: Array<string> = [];
  let conflict = false;

  const note = (
    list: Array<TimelineChanges>,
    timelinePath: string,
    from: Timeline,
    to: Timeline,
  ) => {
    const diff = attempt(() => diffTimelines(from, to));
    if (diff !== null && diff.changes.length > 0) list.push({ timelinePath, diff });
  };
  const notePending = (timelinePath: string, pulled: string, mine: Timeline) =>
    Effect.map(readBase(input.projectDir, timelinePath, pulled), (base) => {
      if (base !== null) note(pending, timelinePath, base, mine);
    });
  // A timeline pulled before bases were kept gets one while it still holds Premiere's text.
  const ensureBase = Effect.fn("timeline.premiereSync.ensureBase")(function* (
    timelinePath: string,
    text: string,
  ) {
    if (yield* hasSnapshot(input.projectDir, timelinePath, sha(text))) return;
    yield* writeBase({ projectDir: input.projectDir, timelinePath, text });
  });
  /** `before` is the text the file held, so edits made here stay in the history when replaced. */
  const record = (timelinePath: string, text: string, before: string | undefined, label: string) =>
    recordVersion({
      projectDir: input.projectDir,
      timelinePath,
      text,
      ...(before === undefined ? {} : { before }),
      by: "premiere",
      label,
    });

  if (unchanged && input.usePremiere !== true && !mergeRemembered) {
    for (const [timelinePath, entry] of Object.entries(link.timelines)) {
      const mine = local.get(timelinePath);
      if (mine === undefined) continue;
      timelines[timelinePath] = entry;
      if (mine.hash === entry.pulled) {
        yield* ensureBase(timelinePath, mine.text);
        continue;
      }
      kept.push(timelinePath);
      if (entry.premiere !== entry.pulled) conflict = true;
      yield* notePending(timelinePath, entry.pulled, mine.timeline);
    }
  } else {
    const bytes = yield* fs.readFile(link.project).pipe(Effect.option);
    if (Option.isNone(bytes)) return none("offline");
    // Premiere replaces the file as it saves; a read that lands mid-save is retried next sync.
    const project = attempt(() => parsePrproj(bytes.value));
    if (project === null) return none("offline", saved.modified);
    const names = new Map(project.sequences.map((sequence) => [sequence.id, sequence.name]));
    for (const [timelinePath, entry] of Object.entries(link.timelines)) {
      const mine = local.get(timelinePath);
      if (mine === undefined) continue;
      const before = link.sequences?.[entry.sequenceId];
      const name = names.get(entry.sequenceId);
      if (name === undefined) {
        // Said once: the next link no longer lists the sequence. The timeline stays as it was.
        if (link.sequences === undefined || before !== undefined) {
          sequenceChanges.push({
            kind: "removed",
            name: before ?? mine.timeline.name,
            timelinePath,
          });
        }
      } else if (before !== undefined && before !== name) {
        sequenceChanges.push({ kind: "renamed", before, name, timelinePath });
      }
      const mediaRoot = mediaRootOf(mine.timeline);
      const pulled = attempt(() =>
        project.readSequence(entry.sequenceId, mediaRoot === undefined ? undefined : { mediaRoot }),
      );
      if (pulled === null) {
        timelines[timelinePath] = entry;
        continue;
      }
      const text = serializeTimeline(pulled.timeline);
      const theirs = sha(text);
      const current = { ...entry, pulled: theirs, premiere: theirs };
      if (mine.hash === theirs) {
        timelines[timelinePath] = current;
        yield* ensureBase(timelinePath, text);
        continue;
      }
      const editedHere = mine.hash !== entry.pulled;
      const base = editedHere
        ? yield* readBase(input.projectDir, timelinePath, entry.pulled)
        : mine.timeline;
      if (editedHere && input.usePremiere !== true) {
        const premiereChanged = theirs !== entry.pulled;
        // A push that was applied and saved: Premiere made the changes made here and holds the
        // same cut, so nothing is in conflict.
        const pushed =
          premiereChanged &&
          base !== null &&
          (attempt(() => diffTimelines(base, pulled.timeline))?.changes.length ?? 0) > 0 &&
          attempt(() => diffTimelines(mine.timeline, pulled.timeline))?.changes.length === 0;
        const merged =
          premiereChanged && (input.merge === true || pushed) && base !== null
            ? attempt(() => mergeTimelines(base, mine.timeline, pulled.timeline))
            : null;
        if (merged === null || base === null) {
          timelines[timelinePath] = { ...entry, premiere: theirs };
          kept.push(timelinePath);
          if (premiereChanged) {
            conflict = true;
            if (input.merge === true) unmerged.push(timelinePath);
          }
          if (base !== null) note(pending, timelinePath, base, mine.timeline);
          continue;
        }
        const mergedText = serializeTimeline(merged.timeline);
        yield* writeBlobs(input.projectDir, pulled.blobs);
        yield* writeBase({ projectDir: input.projectDir, timelinePath, text });
        yield* fs.writeFileString(path.join(input.projectDir, timelinePath), mergedText);
        yield* record(
          timelinePath,
          mergedText,
          mine.text,
          "Merged Premiere's save with the edits made here",
        );
        timelines[timelinePath] = current;
        updated.push(timelinePath);
        note(changes, timelinePath, base, pulled.timeline);
        if (merged.conflicts.length > 0) {
          conflicts.push({ timelinePath, conflicts: merged.conflicts });
        }
        if (sha(mergedText) !== theirs) {
          kept.push(timelinePath);
          note(pending, timelinePath, pulled.timeline, merged.timeline);
        }
        continue;
      }
      yield* writeBlobs(input.projectDir, pulled.blobs);
      yield* fs.writeFileString(path.join(input.projectDir, timelinePath), text);
      yield* writeBase({ projectDir: input.projectDir, timelinePath, text });
      yield* record(
        timelinePath,
        text,
        mine.text,
        editedHere ? "Replaced by Premiere's version" : "Pulled from Premiere",
      );
      timelines[timelinePath] = current;
      updated.push(timelinePath);
      note(changes, timelinePath, base ?? mine.timeline, pulled.timeline);
    }

    // Only sequences made since a save was read with this known: the first read is the baseline,
    // so the sequences a project already had when it was linked are not all pulled in.
    if (link.sequences !== undefined) {
      const linked = new Set(Object.values(link.timelines).map((entry) => entry.sequenceId));
      const mediaRoot = [...local.values()]
        .map((mine) => mediaRootOf(mine.timeline))
        .find((root) => root !== undefined);
      for (const sequence of project.sequences) {
        if (link.sequences[sequence.id] !== undefined || linked.has(sequence.id)) continue;
        const timelinePath = `timelines/${timelineFileName(sequence.name)}`;
        const taken =
          timelines[timelinePath] !== undefined ||
          (yield* fs
            .exists(path.join(input.projectDir, timelinePath))
            .pipe(Effect.orElseSucceed(() => true)));
        const pulled = taken
          ? null
          : attempt(() =>
              project.readSequence(
                sequence.id,
                mediaRoot === undefined ? undefined : { mediaRoot },
              ),
            );
        if (pulled === null) {
          sequenceChanges.push({ kind: "added", name: sequence.name, timelinePath: null });
          continue;
        }
        const text = serializeTimeline(pulled.timeline);
        const hash = sha(text);
        yield* writeBlobs(input.projectDir, pulled.blobs);
        yield* fs.makeDirectory(path.join(input.projectDir, "timelines"), { recursive: true });
        yield* fs.writeFileString(path.join(input.projectDir, timelinePath), text);
        yield* writeBase({ projectDir: input.projectDir, timelinePath, text });
        yield* record(timelinePath, text, undefined, "Pulled from Premiere");
        timelines[timelinePath] = { sequenceId: sequence.id, pulled: hash, premiere: hash };
        updated.push(timelinePath);
        sequenceChanges.push({ kind: "added", name: sequence.name, timelinePath });
      }
    }
    sequences = Object.fromEntries(names);
  }

  const next: PremiereLink = {
    version: 1,
    project: link.project,
    saved,
    timelines,
    ...(sequences === undefined ? {} : { sequences }),
  };
  const nextText = serializeJson(next);
  if (nextText !== serializeJson(link) || !unchanged) {
    yield* fs.writeFileString(path.join(input.projectDir, PREMIERE_LINK_PATH), nextText);
  }
  const state: PremiereSyncState = conflict
    ? "conflict"
    : kept.length > 0
      ? "edited"
      : updated.length > 0
        ? "updated"
        : "current";
  const result: PremiereSyncResult = {
    state,
    premiereSavedAt: saved.modified,
    updated,
    kept,
    changes,
    pending,
    conflicts,
    sequences: sequenceChanges,
    unmerged,
  };
  return result;
});

/**
 * How the timelines stand against the linked Premiere project, read without pulling or writing
 * anything: `behind` is a save in Premiere that no sync has read yet, `edited` is edits made
 * here that Premiere doesn't have, `conflict` both on one timeline as the last sync found it.
 */
export const premiereLinkStatus = Effect.fn("timeline.premiereLinkStatus")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const link = yield* readLink(projectDir);
  if (link === null) return { state: "unlinked" as const, project: null };
  const stat = yield* fs.stat(link.project).pipe(Effect.option);
  if (Option.isNone(stat)) return { state: "offline" as const, project: link.project };
  const modified = Option.match(stat.value.mtime, { onNone: () => 0, onSome: (d) => d.getTime() });
  const behind =
    link.saved === null ||
    link.saved.size !== Number(stat.value.size) ||
    link.saved.modified !== modified;
  let edited = false;
  let conflict = false;
  for (const [timelinePath, entry] of Object.entries(link.timelines)) {
    const text = yield* fs.readFileString(path.join(projectDir, timelinePath)).pipe(Effect.option);
    if (Option.isNone(text) || sha(text.value) === entry.pulled) continue;
    edited = true;
    if (entry.premiere !== entry.pulled) conflict = true;
  }
  return {
    state: conflict
      ? ("conflict" as const)
      : behind
        ? ("behind" as const)
        : edited
          ? ("edited" as const)
          : ("current" as const),
    project: link.project,
  };
});
