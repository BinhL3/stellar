/**
 * Voice-over takes on disk: WAVs under `<mediaRoot>/Audio/VO`, and `voiceover.json` in the
 * project folder saying which script line each was recorded for and which one the line uses.
 */
import { serializeJson } from "@t3tools/timeline/otio";
import { NO_TAKES, type VoiceOverIndex } from "@t3tools/timeline/voiceOver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

const TAKE_INDEX_FILE = "voiceover.json";
/** Relative to the media root, with forward slashes as timelines name media. */
export const TAKE_FOLDER = "Audio/VO";

const TakeIndex = Schema.Struct({
  takes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      beatId: Schema.String,
      file: Schema.String,
      seconds: Schema.Number,
      source: Schema.Literals(["recorded", "imported", "split"]),
      createdAt: Schema.Number,
    }),
  ),
  chosen: Schema.Record(Schema.String, Schema.String),
  nextId: Schema.Number,
});
const decodeTakeIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(TakeIndex));

/** The project's takes; a project that has recorded none has no file. */
export const readTakeIndex = Effect.fn("VideoProjects.readTakeIndex")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(projectDir, TAKE_INDEX_FILE)).pipe(
    Effect.flatMap(decodeTakeIndex),
    Effect.orElseSucceed((): VoiceOverIndex => NO_TAKES),
  );
});

export const writeTakeIndex = Effect.fn("VideoProjects.writeTakeIndex")(function* (
  projectDir: string,
  index: VoiceOverIndex,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(projectDir, TAKE_INDEX_FILE);
  // Renamed into place, so a reader never sees half an index.
  yield* fs.writeFileString(`${file}.part`, serializeJson(index));
  yield* fs.rename(`${file}.part`, file);
});

/**
 * Writes `source`, or the stretch of it from `from` to `to` seconds, as the 48 kHz WAV Premiere
 * imports, and returns its length in seconds; null, with nothing written, when it holds no audio.
 */
export const encodeTake = Effect.fn("VideoProjects.encodeTake")(function* (input: {
  readonly source: string;
  readonly target: string;
  readonly from?: number;
  readonly to?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* fs.makeDirectory(path.dirname(input.target), { recursive: true });
  yield* spawner.string(
    ChildProcess.make("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      input.source,
      ...(input.from === undefined ? [] : ["-ss", String(input.from)]),
      ...(input.to === undefined ? [] : ["-to", String(input.to)]),
      "-vn",
      "-ar",
      "48000",
      "-c:a",
      "pcm_s24le",
      input.target,
    ]),
  );
  const seconds = Number(
    (yield* spawner.string(
      ChildProcess.make("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        input.target,
      ]),
    )).trim(),
  );
  // A file with no audio in it encodes to an empty WAV; it is not a take.
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  yield* fs.remove(input.target, { force: true });
  return null;
});
