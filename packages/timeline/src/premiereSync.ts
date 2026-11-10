// @effect-diagnostics nodeBuiltinImport:off -- Hashing timeline text to tell whose version a file holds.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { serializeJson, serializeTimeline, TIMELINE_NAMESPACE, type Timeline } from "./otio.ts";
import { parsePrproj } from "./premiere/prproj.ts";

/**
 * Which Premiere project a Stellar project follows, and whose version each timeline holds.
 * A `.prproj` only changes when Premiere saves, so its size and modified time say whether there
 * is anything new to pull without opening it.
 */
export const PREMIERE_LINK_PATH = "premiere.json";
/** A timeline replaced by Premiere's version while it held edits made here is kept in this folder. */
export const REPLACED_DIRECTORY = "timelines/replaced";

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
  /** Timelines that differ from Premiere's save and were left alone. */
  readonly kept: ReadonlyArray<string>;
}

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
  };
  yield* fs.writeFileString(path.join(input.projectDir, PREMIERE_LINK_PATH), serializeJson(link));
});

/**
 * Brings a project's timelines up to Premiere's latest save. Unchanged saves cost one `stat`.
 * A timeline that was edited here is never overwritten unless `usePremiere` says to, and then
 * the replaced version is kept in `timelines/replaced/`.
 */
export const syncFromPremiere = Effect.fn("timeline.syncFromPremiere")(function* (input: {
  readonly projectDir: string;
  readonly usePremiere?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const none = (state: PremiereSyncState, premiereSavedAt: number | null = null) =>
    ({ state, premiereSavedAt, updated: [], kept: [] }) satisfies PremiereSyncResult;
  const link = (yield* readLink(input.projectDir)) ?? (yield* inferLink(input.projectDir));
  if (link === null) return none("unlinked");
  const stat = yield* fs.stat(link.project).pipe(Effect.option);
  if (Option.isNone(stat)) return none("offline");
  const saved = {
    size: Number(stat.value.size),
    modified: Option.match(stat.value.mtime, { onNone: () => 0, onSome: (d) => d.getTime() }),
  };

  const local = new Map<string, { readonly text: string; readonly timeline: Timeline }>();
  for (const timelinePath of Object.keys(link.timelines)) {
    const read = yield* readTimeline(path.join(input.projectDir, timelinePath)).pipe(Effect.option);
    if (Option.isSome(read)) local.set(timelinePath, read.value);
  }

  const unchanged =
    link.saved !== null && link.saved.size === saved.size && link.saved.modified === saved.modified;
  const timelines: Record<string, LinkedTimeline> = {};
  const updated: Array<string> = [];
  const kept: Array<string> = [];
  let conflict = false;

  if (unchanged && input.usePremiere !== true) {
    for (const [timelinePath, entry] of Object.entries(link.timelines)) {
      const mine = local.get(timelinePath);
      if (mine === undefined) continue;
      timelines[timelinePath] = entry;
      if (sha(mine.text) === entry.pulled) continue;
      kept.push(timelinePath);
      if (entry.premiere !== entry.pulled) conflict = true;
    }
  } else {
    const bytes = yield* fs.readFile(link.project).pipe(Effect.option);
    if (Option.isNone(bytes)) return none("offline");
    // Premiere replaces the file as it saves; a read that lands mid-save is retried next sync.
    const project = attempt(() => parsePrproj(bytes.value));
    if (project === null) return none("offline", saved.modified);
    for (const [timelinePath, entry] of Object.entries(link.timelines)) {
      const mine = local.get(timelinePath);
      if (mine === undefined) continue;
      const mediaRoot = mediaRootOf(mine.timeline);
      // A sequence deleted in Premiere leaves its timeline as it was.
      const pulled = attempt(() =>
        project.readSequence(entry.sequenceId, mediaRoot === undefined ? undefined : { mediaRoot }),
      );
      if (pulled === null) {
        timelines[timelinePath] = entry;
        continue;
      }
      const text = serializeTimeline(pulled.timeline);
      const theirs = sha(text);
      const ours = sha(mine.text);
      if (ours === theirs) {
        timelines[timelinePath] = { ...entry, pulled: theirs, premiere: theirs };
        continue;
      }
      const editedHere = ours !== entry.pulled;
      if (editedHere && input.usePremiere !== true) {
        timelines[timelinePath] = { ...entry, premiere: theirs };
        kept.push(timelinePath);
        if (theirs !== entry.pulled) conflict = true;
        continue;
      }
      if (editedHere) {
        const replaced = path.join(input.projectDir, REPLACED_DIRECTORY);
        yield* fs.makeDirectory(replaced, { recursive: true });
        yield* fs.writeFileString(path.join(replaced, path.basename(timelinePath)), mine.text);
      }
      yield* fs.makeDirectory(path.join(input.projectDir, "effects"), { recursive: true });
      for (const [ref, blob] of pulled.blobs) {
        yield* fs.writeFileString(
          path.join(input.projectDir, "effects", `${ref.slice("sha256:".length)}.premiere.json`),
          serializeJson(blob),
        );
      }
      yield* fs.writeFileString(path.join(input.projectDir, timelinePath), text);
      timelines[timelinePath] = { ...entry, pulled: theirs, premiere: theirs };
      updated.push(timelinePath);
    }
  }

  const next: PremiereLink = { version: 1, project: link.project, saved, timelines };
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
  return { state, premiereSavedAt: saved.modified, updated, kept } satisfies PremiereSyncResult;
});
