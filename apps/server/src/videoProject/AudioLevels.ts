/**
 * Each source's measured audio levels, made once with ffmpeg and kept beside its transcript as
 * `<name>.levels.json`. They say where a recording is quiet, which word timings can't.
 */
import {
  LEVEL_SAMPLE_RATE,
  LEVELS_VERSION,
  levelsOf,
  makeLevelMeter,
} from "@t3tools/timeline/levels";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const LevelsFile = Schema.Struct({
  version: Schema.Number,
  /** The measured file's size and modified time, so a replaced file is measured again. */
  size: Schema.Number,
  modifiedAt: Schema.Number,
  step: Schema.Number,
  db: Schema.Array(Schema.Number),
});
const LevelsJson = Schema.fromJsonString(LevelsFile);
const decodeLevelsFile = Schema.decodeUnknownEffect(LevelsJson);
const encodeLevelsFile = Schema.encodeEffect(LevelsJson);

/** Why a source has no levels, in words an agent can pass on. */
export interface LevelsUnavailable {
  readonly unavailable: string;
}

export const NO_FFMPEG =
  "ffmpeg is not installed on this machine, so audio levels can't be measured";

/**
 * The levels of a media file (absolute, or relative to the media root), measured now unless a
 * current measurement sits beside `transcriptFile`. Never fails: without ffmpeg, or with audio
 * it can't read, it says why.
 */
export const ensureLevels = Effect.fn("VideoProjects.ensureLevels")(function* (input: {
  readonly mediaRoot: string;
  readonly target: string;
  readonly transcriptFile: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const media = path.isAbsolute(input.target)
    ? input.target
    : path.join(input.mediaRoot, input.target);
  const name = path.basename(input.target, path.extname(input.target));
  const file = path.join(path.dirname(input.transcriptFile), `${name}.levels.json`);
  const stat = yield* fs.stat(media).pipe(Effect.option);
  const size = Option.match(stat, { onNone: () => -1, onSome: (info) => Number(info.size) });
  const modifiedAt = Option.match(stat, {
    onNone: () => -1,
    onSome: (info) =>
      Option.match(info.mtime, { onNone: () => 0, onSome: (modified) => modified.getTime() }),
  });
  const cached = yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(decodeLevelsFile), Effect.option);
  if (
    Option.isSome(cached) &&
    cached.value.version === LEVELS_VERSION &&
    // A drive that is away can't be checked against; what was measured still stands.
    (Option.isNone(stat) || (cached.value.size === size && cached.value.modifiedAt === modifiedAt))
  ) {
    return levelsOf(cached.value.db, cached.value.step);
  }
  if (Option.isNone(stat)) return { unavailable: `${input.target} is not on this machine` };
  const meter = makeLevelMeter();
  const measured = yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make("ffmpeg", [
        "-v",
        "error",
        "-nostdin",
        "-i",
        media,
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        String(LEVEL_SAMPLE_RATE),
        "-f",
        "s16le",
        "-",
      ]),
    );
    const [, errors, exitCode] = yield* Effect.all(
      [
        Stream.runForEach(child.stdout, (chunk) => Effect.sync(() => meter.push(chunk))),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return Number(exitCode) === 0
      ? null
      : `ffmpeg could not read the audio of ${input.target}: ${errors.trim().split("\n").at(-1) ?? `exit ${exitCode}`}`;
  }).pipe(
    Effect.scoped,
    // The spawn itself failing is the tool not being there.
    Effect.orElseSucceed(() => NO_FFMPEG),
  );
  if (measured !== null) return { unavailable: measured } satisfies LevelsUnavailable;
  const levels = meter.finish();
  if (levels.db.length === 0) return { unavailable: `${input.target} has no audio to measure` };
  const part = `${file}.part`;
  yield* encodeLevelsFile({
    version: LEVELS_VERSION,
    size,
    modifiedAt,
    step: levels.step,
    db: levels.db,
  }).pipe(
    Effect.flatMap((text) => fs.writeFileString(part, text)),
    Effect.andThen(fs.rename(part, file)),
    Effect.catch((cause) =>
      Effect.logWarning("Could not keep audio levels", { file, cause }).pipe(
        Effect.andThen(fs.remove(part, { force: true })),
        Effect.ignore,
      ),
    ),
  );
  return levels;
});
