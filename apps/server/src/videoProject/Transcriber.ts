/**
 * Word-timed transcripts for a video project, made by the host's transcriber: a command run as
 * `<command> words <media> -o <out.words.json> [--lang en|vi]` that writes `[{ w, start, end }]`.
 */
import type { VideoTranscriptStatus } from "@t3tools/contracts";
import { listFootage } from "@t3tools/timeline/footage";
import { serializeJson } from "@t3tools/timeline/otio";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

/** Progress of a transcription run, in the project folder; clients re-read it while it runs. */
const TRANSCRIPT_STATUS_FILE = "transcripts.json";
/** New transcripts go here; a project's own pipeline may also write under its `transcripts/`. */
const TRANSCRIPT_FOLDER = "Audio";
const VOICE_OVER_FOLDER = "Audio/VO";
const PROJECT_FILE = "project.json";

const TranscriptLanguage = Schema.Literals(["en", "vi"]);
type TranscriptLanguage = typeof TranscriptLanguage.Type;

export const decodeTranscript = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ w: Schema.String, start: Schema.Number, end: Schema.Number })),
  ),
);
const decodeProjectFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ language: Schema.optional(TranscriptLanguage) })),
);

/**
 * The transcript of a media file (absolute, or relative to the media root), or null. Pipelines
 * differ on where transcripts go (Audio/ in one project, Audio/transcripts/ in another), and a
 * timeline's media can live in another project's folder, so this looks in the Audio folder of
 * this project and of each folder above the media file, nearest first.
 */
// Untraced: called once per clip of a project, inside the operation that lists them.
export const findTranscript = Effect.fnUntraced(function* (mediaRoot: string, target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const name = `${path.basename(target, path.extname(target))}.words.json`;
  const media = path.isAbsolute(target) ? target : path.join(mediaRoot, target);
  const folders = [mediaRoot];
  for (let folder = path.dirname(media), up = 0; up < 5; folder = path.dirname(folder), up++) {
    if (!folders.includes(folder)) folders.push(folder);
  }
  for (const folder of folders) {
    for (const candidate of [
      path.join(folder, TRANSCRIPT_FOLDER, name),
      path.join(folder, TRANSCRIPT_FOLDER, "transcripts", name),
    ]) {
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
    }
  }
  return null;
});

/**
 * The media with speech to transcribe (footage and voice-over takes, relative to the media
 * root) and which of it has no transcript yet.
 */
export const transcriptCoverage = Effect.fn("VideoProjects.transcriptCoverage")(function* (
  mediaRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const takes = yield* fs
    .readDirectory(path.join(mediaRoot, VOICE_OVER_FOLDER))
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  const candidates = [
    ...(yield* listFootage(mediaRoot)),
    ...takes
      .filter((name) => /\.wav$/i.test(name) && !name.startsWith("."))
      .map((name) => `${VOICE_OVER_FOLDER}/${name}`)
      .toSorted(),
  ];
  const missing: Array<string> = [];
  for (const candidate of candidates) {
    if ((yield* findTranscript(mediaRoot, candidate)) === null) missing.push(candidate);
  }
  return { total: candidates.length, missing };
});

/** The language a project's speech is in, when its `project.json` says. */
export const projectLanguage = Effect.fn("VideoProjects.projectLanguage")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(projectDir, PROJECT_FILE)).pipe(
    Effect.flatMap(decodeProjectFile),
    Effect.map((project) => project.language),
    Effect.orElseSucceed(() => undefined),
  );
});

export const writeTranscriptStatus = Effect.fn("VideoProjects.writeTranscriptStatus")(function* (
  projectDir: string,
  status: VideoTranscriptStatus,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(projectDir, TRANSCRIPT_STATUS_FILE);
  yield* fs
    .writeFileString(`${file}.part`, serializeJson(status))
    .pipe(Effect.andThen(fs.rename(`${file}.part`, file)), Effect.ignore);
});

/**
 * Transcribes `targets` one at a time into `<mediaRoot>/Audio/<name>.words.json`, reporting to
 * `transcripts.json` as it goes. A file the transcriber fails on is listed and the run goes on.
 */
export const runTranscription = Effect.fn("VideoProjects.runTranscription")(function* (input: {
  readonly projectDir: string;
  readonly command: string;
  readonly language: TranscriptLanguage | undefined;
  /** Media-root-relative files to transcribe. */
  readonly targets: ReadonlyArray<string>;
  /** What `transcriptCoverage` said before the run. */
  readonly coverage: { readonly total: number; readonly missing: ReadonlyArray<string> };
  readonly onStatus?: (status: VideoTranscriptStatus) => Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const mediaRoot = path.dirname(input.projectDir);
  const folder = path.join(mediaRoot, TRANSCRIPT_FOLDER);
  const missing = new Set(input.coverage.missing);
  const failed: Array<string> = [];
  const report = (building: VideoTranscriptStatus["building"]) => {
    const status: VideoTranscriptStatus = {
      building,
      ready: input.coverage.total - missing.size,
      total: input.coverage.total,
      failed: [...failed],
      unavailable: null,
    };
    return writeTranscriptStatus(input.projectDir, status).pipe(
      Effect.andThen(input.onStatus?.(status) ?? Effect.void),
      Effect.as(status),
    );
  };

  return yield* Effect.gen(function* () {
    for (const [done, target] of input.targets.entries()) {
      yield* report({ done, total: input.targets.length });
      // Checked again here: two files can share a name, and a pipeline may have written one since.
      if ((yield* findTranscript(mediaRoot, target)) !== null) {
        missing.delete(target);
        continue;
      }
      const out = path.join(folder, `${path.basename(target, path.extname(target))}.words.json`);
      const part = `${out}.part`;
      const written = yield* Effect.gen(function* () {
        yield* fs.makeDirectory(folder, { recursive: true });
        yield* fs.remove(part, { force: true });
        yield* spawner.string(
          ChildProcess.make(input.command, [
            "words",
            path.join(mediaRoot, target),
            "-o",
            part,
            ...(input.language === undefined ? [] : ["--lang", input.language]),
          ]),
        );
        // Only a transcript that reads back is kept, whatever the command's exit said.
        yield* fs.readFileString(part).pipe(Effect.flatMap(decodeTranscript));
        yield* fs.rename(part, out);
      }).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("Transcription failed", { target, cause }).pipe(Effect.as(false)),
        ),
        Effect.ensuring(fs.remove(part, { force: true }).pipe(Effect.ignore)),
      );
      if (written) missing.delete(target);
      else failed.push(target);
    }
    return yield* report(null);
  }).pipe(
    // A run cut short (the server stopping) must not leave the status saying it is still going.
    Effect.onInterrupt(() => report(null)),
  );
});
