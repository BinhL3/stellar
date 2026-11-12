import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { serializeJson, serializeTimeline } from "./otio.ts";
import { parsePrproj } from "./premiere/prproj.ts";
import { keepBase, recordVersion } from "./versions.ts";

/** The file name a sequence's timeline is written under. */
export const timelineFileName = (sequenceName: string) =>
  `${sequenceName.replace(/[^\w.-]+/g, "_")}.otio`;

/**
 * Where the text last written from Premiere was kept before timelines had a history. It now
 * lives in the history's store (`versions.ts`); this is only read, for projects pulled earlier.
 */
export const BASE_DIRECTORY = "timelines/.base";

/**
 * Keeps the text last written from Premiere: what both sides started from, so edits made here
 * and in Premiere can be told apart and merged. `timelinePath` is relative to the project folder.
 */
export const writeBase = keepBase;

/** Writes each native effect stack a pull read as `effects/<sha256>.premiere.json`. */
export const writeBlobs = Effect.fn("timeline.writeBlobs")(function* (
  projectDir: string,
  blobs: ReadonlyMap<string, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(projectDir, "effects"), { recursive: true });
  for (const [ref, blob] of blobs) {
    yield* fs.writeFileString(
      path.join(projectDir, "effects", `${ref.slice("sha256:".length)}.premiere.json`),
      serializeJson(blob),
    );
  }
});

/**
 * Pulls one sequence of a Premiere project into a Stellar project folder: `timelines/<name>.otio`
 * plus each native effect stack as `effects/<sha256>.premiere.json`.
 */
export const pullToProject = Effect.fn("timeline.pullToProject")(function* (input: {
  readonly prproj: Uint8Array;
  readonly sequence: string;
  readonly projectDir: string;
  readonly mediaRoot?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pulled = parsePrproj(input.prproj).readSequence(
    input.sequence,
    input.mediaRoot === undefined ? undefined : { mediaRoot: input.mediaRoot },
  );
  yield* fs.makeDirectory(path.join(input.projectDir, "timelines"), { recursive: true });
  const timelinePath = path.join(
    input.projectDir,
    "timelines",
    timelineFileName(pulled.timeline.name),
  );
  const text = serializeTimeline(pulled.timeline);
  const before = yield* fs.readFileString(timelinePath).pipe(Effect.option);
  yield* fs.writeFileString(timelinePath, text);
  yield* writeBase({ projectDir: input.projectDir, timelinePath, text });
  yield* recordVersion({
    projectDir: input.projectDir,
    timelinePath,
    text,
    ...(before._tag === "Some" ? { before: before.value } : {}),
    by: "premiere",
    label: "Pulled from Premiere",
  });
  yield* writeBlobs(input.projectDir, pulled.blobs);
  return { ...pulled, timelinePath, text };
});
