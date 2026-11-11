import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { serializeJson, serializeTimeline } from "./otio.ts";
import { parsePrproj } from "./premiere/prproj.ts";

/** The file name a sequence's timeline is written under. */
export const timelineFileName = (sequenceName: string) =>
  `${sequenceName.replace(/[^\w.-]+/g, "_")}.otio`;

/**
 * The text last written from Premiere for each timeline, by file name. It is what both sides
 * started from, so edits made here and in Premiere can be told apart and merged.
 */
export const BASE_DIRECTORY = "timelines/.base";

/** `timelinePath` is relative to the project folder. */
export const writeBase = Effect.fn("timeline.writeBase")(function* (input: {
  readonly projectDir: string;
  readonly timelinePath: string;
  readonly text: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(input.projectDir, BASE_DIRECTORY);
  yield* fs.makeDirectory(folder, { recursive: true });
  yield* fs.writeFileString(path.join(folder, path.basename(input.timelinePath)), input.text);
});

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
  yield* fs.writeFileString(timelinePath, text);
  yield* writeBase({ projectDir: input.projectDir, timelinePath, text });
  yield* writeBlobs(input.projectDir, pulled.blobs);
  return { ...pulled, timelinePath, text };
});
