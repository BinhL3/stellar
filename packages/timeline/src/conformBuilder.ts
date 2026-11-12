// @effect-diagnostics nodeBuiltinImport:off -- Hashing a media file's identity for its frame table's name.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  adoptedTies,
  conformArguments,
  conformedPath,
  conformProgress,
  type ConformState,
  conformState,
  type ConformTie,
  EMPTY_MEDIA_INDEX,
  type FileStamp,
  FRAME_TABLE_DIRECTORY,
  MEDIA_INDEX_PATH,
  type MediaIndex,
  type MediaTiming,
  tieState,
} from "./conform.ts";
import { listFootage } from "./footage.ts";
import {
  averageRate,
  frameSeconds,
  type FrameTable,
  frameTableFrom,
  isVariableRate,
  rateSegments,
} from "./frameTimes.ts";
import { serializeJson } from "./otio.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const PROBE_CONCURRENCY = 3;
// A copy whose length is further than this from its original's is not kept.
const LENGTH_TOLERANCE_SECONDS = 0.5;

export class ConformError extends Schema.TaggedError<ConformError>()("ConformError", {
  file: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `${this.file}: ${this.reason}`;
  }
}

export const readMediaIndex = Effect.fn("timeline.readMediaIndex")(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(projectDir, MEDIA_INDEX_PATH)).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((value) => ((value as MediaIndex).version === 1 ? (value as MediaIndex) : null)),
    Effect.orElseSucceed(() => null),
    Effect.map((index) => index ?? EMPTY_MEDIA_INDEX),
  );
});

const stamp = Effect.fn("timeline.conform.stamp")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(file).pipe(
    Effect.map((stat): FileStamp => ({
      size: Number(stat.size),
      modified: Option.match(stat.mtime, { onNone: () => 0, onSome: (d) => d.getTime() }),
    })),
    Effect.option,
    Effect.map(Option.getOrUndefined),
  );
});

/**
 * A project's ties as they stand on disk now: which copy to use for which original, and what
 * still needs conforming. Costs one `stat` per recorded file; nothing is probed.
 */
export const readConformState = Effect.fn("timeline.readConformState")(function* (
  projectDir: string,
) {
  const path = yield* Path.Path;
  const mediaRoot = path.dirname(path.resolve(projectDir));
  const index = yield* readMediaIndex(projectDir);
  const stamps = new Map<string, FileStamp>();
  const targets = new Set([
    ...Object.keys(index.media),
    ...index.conformed.flatMap((tie) => [tie.original, tie.copy]),
  ]);
  for (const target of targets) {
    const found = yield* stamp(path.join(mediaRoot, target));
    if (found !== undefined) stamps.set(target, found);
  }
  return { index, state: conformState(index, stamps) };
});

/**
 * Reads every video frame's timestamp from the packets, without decoding. The whole file is
 * read from disk, so it takes about as long as copying it: around a second per gigabyte on a
 * fast SSD, and next to nothing straight after intake copied the file.
 */
const probeTimes = Effect.fn("timeline.conform.probeTimes")(function* (file: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner.string(
    ChildProcess.make("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=time_base:packet=pts",
      "-of",
      "csv=p=1",
      file,
    ]),
  );
  const pts: Array<number> = [];
  let timescale = 0;
  for (const line of output.split("\n")) {
    const [kind, value = ""] = line.trim().split(",");
    if (kind === "packet" && /^-?\d+$/.test(value)) pts.push(Number(value));
    else if (kind === "stream") {
      const [top, bottom] = value.split("/").map(Number);
      if (top !== undefined && bottom !== undefined && top > 0) timescale = bottom / top;
    }
  }
  if (pts.length < 2 || timescale <= 0) {
    return yield* new ConformError({ file, reason: "no video frame timestamps" });
  }
  return frameTableFrom(pts, timescale);
});

const writeJson = Effect.fn("timeline.conform.writeJson")(function* (file: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(`${file}.part`, serializeJson(value));
  yield* fs.rename(`${file}.part`, file);
});

/** A clip's rate facts, and its frame table written to the project when it is variable. */
const readTiming = Effect.fn("timeline.conform.readTiming")(function* (input: {
  readonly projectDir: string;
  readonly mediaRoot: string;
  readonly target: string;
  readonly stamp: FileStamp;
}) {
  const path = yield* Path.Path;
  const table = yield* probeTimes(path.join(input.mediaRoot, input.target));
  const times = frameSeconds(table);
  const variable = isVariableRate(times);
  const timing: { -readonly [K in keyof MediaTiming]: MediaTiming[K] } = {
    size: input.stamp.size,
    modified: input.stamp.modified,
    frames: table.frames,
    duration: times[times.length - 1] ?? 0,
    fps: Math.round(averageRate(times) * 1000) / 1000,
    variable,
    segments: rateSegments(times).map((segment) => ({
      start: Math.round(segment.start * 1000) / 1000,
      end: Math.round(segment.end * 1000) / 1000,
      fps: Math.round(segment.fps * 1000) / 1000,
    })),
  };
  if (variable) {
    // Named for the file's place and state, not its absolute path, so the drive can move.
    const key = NodeCrypto.createHash("sha256")
      .update(`${input.target}|${input.stamp.size}|${input.stamp.modified}`)
      .digest("hex")
      .slice(0, 16);
    timing.table = `${FRAME_TABLE_DIRECTORY}/${key}.json`;
    yield* writeJson(path.join(input.projectDir, timing.table), table);
  }
  return timing satisfies MediaTiming;
});

/** A clip's frame times in seconds, or null when it is constant rate and needs no table. */
export const loadFrameTimes = Effect.fn("timeline.loadFrameTimes")(function* (
  projectDir: string,
  timing: MediaTiming | undefined,
) {
  if (timing?.table === undefined) return null;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(projectDir, timing.table)).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((value) => frameSeconds(value as FrameTable)),
    Effect.orElseSucceed(() => null),
  );
});

/** The HEVC encoder this machine's ffmpeg has: hardware on a Mac, software elsewhere. */
const pickEncoder = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const encoders = yield* spawner
    .string(ChildProcess.make("ffmpeg", ["-v", "error", "-hide_banner", "-encoders"]))
    .pipe(Effect.orElseSucceed(() => ""));
  return encoders.includes("hevc_videotoolbox") ? "hevc_videotoolbox" : "libx265";
});

const conformOne = Effect.fn("timeline.conform.conformOne")(function* (input: {
  /** What to call the clip in an error. */
  readonly name: string;
  readonly source: string;
  readonly output: string;
  readonly encoder: string;
  readonly duration: number;
  readonly onFraction: (fraction: number) => Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Not a video extension, so a half-written copy is never listed as footage.
  const part = `${input.output}.part`;
  // Unlinked rather than overwritten: an encoder orphaned by a killed server may still hold it.
  yield* fs.remove(part, { force: true });
  yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "ffmpeg",
        conformArguments({ source: input.source, output: part, encoder: input.encoder }),
      ),
    );
    let reported = -1;
    const [, errors, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => {
            const fraction = conformProgress(line, input.duration);
            // ffmpeg reports twice a second; clients only need whole percents.
            if (fraction === null || Math.floor(fraction * 100) === reported) return Effect.void;
            reported = Math.floor(fraction * 100);
            return input.onFraction(fraction);
          }),
        ),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new ConformError({
        file: input.name,
        reason: errors.trim().split("\n").at(-1) || `ffmpeg exited with ${exitCode}`,
      });
    }
    const length = frameSeconds(yield* probeTimes(part)).at(-1) ?? 0;
    if (Math.abs(length - input.duration) > LENGTH_TOLERANCE_SECONDS) {
      return yield* new ConformError({
        file: input.name,
        reason: `the copy is ${length.toFixed(2)} s long, the original ${input.duration.toFixed(2)} s`,
      });
    }
    yield* fs.rename(part, input.output);
  }).pipe(
    Effect.scoped,
    // Also runs when the server stops mid-encode: the next run starts the copy again.
    Effect.ensuring(fs.remove(part, { force: true }).pipe(Effect.ignore)),
  );
});

export type FootagePrepProgress =
  | { readonly kind: "checking"; readonly done: number; readonly total: number }
  | {
      readonly kind: "conforming";
      readonly file: string;
      /** Clips finished, of the clips this run conforms. */
      readonly done: number;
      readonly total: number;
      /** How far the clip being made has got, 0 to 100. */
      readonly percent: number;
    };

/**
 * Reads the frame rates of everything in `Footage`, writes frame tables, ties hand-made `_5994`
 * copies to their originals and, when `conform` is set, copies each rate-switching clip whole.
 * Unchanged files and current copies are skipped, so a run cut short picks up where it stopped.
 */
export const prepareFootage = Effect.fn("timeline.prepareFootage")(function* (input: {
  readonly projectDir: string;
  readonly conform: boolean;
  readonly onProgress?: (progress: FootagePrepProgress) => Effect.Effect<void>;
}) {
  const report = input.onProgress ?? (() => Effect.void);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = path.resolve(input.projectDir);
  const mediaRoot = path.dirname(projectDir);
  const previous = yield* readMediaIndex(projectDir);
  const targets = yield* listFootage(mediaRoot);
  const stamps = new Map<string, FileStamp>();
  for (const target of targets) {
    const found = yield* stamp(path.join(mediaRoot, target));
    if (found !== undefined) stamps.set(target, found);
  }
  yield* fs.makeDirectory(path.join(projectDir, FRAME_TABLE_DIRECTORY), { recursive: true });

  const media: Record<string, MediaTiming> = {};
  const failed: Record<string, string> = {};
  let checked = 0;
  yield* Effect.forEach(
    [...stamps],
    ([target, current]) =>
      Effect.gen(function* () {
        const known = previous.media[target];
        if (known?.size === current.size && known.modified === current.modified) {
          media[target] = known;
        } else {
          yield* readTiming({ projectDir, mediaRoot, target, stamp: current }).pipe(
            Effect.map((timing) => void (media[target] = timing)),
            Effect.catch((error) => Effect.sync(() => void (failed[target] = error.message))),
          );
        }
        checked += 1;
        yield* report({ kind: "checking", done: checked, total: stamps.size });
      }),
    { concurrency: PROBE_CONCURRENCY, discard: true },
  );

  // A tie whose copy is gone is dropped, so its original counts as needing a copy again.
  let conformed: Array<ConformTie> = previous.conformed.filter(
    (tie) => tieState(tie, stamps.get(tie.original), stamps.get(tie.copy)) !== "missing",
  );
  conformed.push(...adoptedTies({ ...previous, conformed }, stamps));
  const write = () => {
    const index: MediaIndex = {
      version: 1,
      media,
      conformed: conformed.toSorted((a, b) => a.original.localeCompare(b.original)),
      ...(Object.keys(failed).length > 0 ? { failed } : {}),
    };
    return writeJson(path.join(projectDir, MEDIA_INDEX_PATH), index).pipe(Effect.as(index));
  };
  let index = yield* write();
  let state: ConformState = conformState(index, stamps);
  if (!input.conform || state.pending.length === 0) return { index, state };

  const encoder = yield* pickEncoder;
  for (const [done, original] of state.pending.entries()) {
    const timing = media[original];
    const from = stamps.get(original);
    if (timing === undefined || from === undefined) continue;
    const copy = conformedPath(original);
    const progress = (percent: number) =>
      report({ kind: "conforming", file: original, done, total: state.pending.length, percent });
    yield* progress(0);
    yield* conformOne({
      name: original,
      source: path.join(mediaRoot, original),
      output: path.join(mediaRoot, copy),
      encoder,
      duration: timing.duration,
      onFraction: (fraction) => progress(Math.floor(fraction * 100)),
    }).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const made = yield* stamp(path.join(mediaRoot, copy));
          if (made === undefined) return;
          stamps.set(copy, made);
          conformed = [
            ...conformed.filter((tie) => tie.original !== original),
            {
              original,
              copy,
              originalSize: from.size,
              originalModified: from.modified,
              copySize: made.size,
            },
          ];
          // The copy is footage too; its own rate facts are read now rather than next run.
          yield* readTiming({ projectDir, mediaRoot, target: copy, stamp: made }).pipe(
            Effect.map((copyTiming) => void (media[copy] = copyTiming)),
            Effect.ignore,
          );
        }),
      ),
      Effect.catch((error) => Effect.sync(() => void (failed[original] = error.message))),
    );
    // Written after each clip, so a run stopped here keeps the copies it finished.
    index = yield* write();
  }
  state = conformState(index, stamps);
  return { index, state };
});
