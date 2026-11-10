import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { serializeJson, serializeTimeline } from "./otio.ts";
import { parsePrproj } from "./premiere/prproj.ts";

/** The file name a sequence's timeline is written under. */
export const timelineFileName = (sequenceName: string) =>
  `${sequenceName.replace(/[^\w.-]+/g, "_")}.otio`;

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
  yield* fs.makeDirectory(path.join(input.projectDir, "effects"), { recursive: true });
  const timelinePath = path.join(
    input.projectDir,
    "timelines",
    timelineFileName(pulled.timeline.name),
  );
  const text = serializeTimeline(pulled.timeline);
  yield* fs.writeFileString(timelinePath, text);
  for (const [ref, blob] of pulled.blobs) {
    yield* fs.writeFileString(
      path.join(input.projectDir, "effects", `${ref.slice("sha256:".length)}.premiere.json`),
      serializeJson(blob),
    );
  }
  return { ...pulled, timelinePath, text };
});
