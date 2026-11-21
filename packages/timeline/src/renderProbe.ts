// @effect-diagnostics nodeBuiltinImport:off -- Hashing timeline text to tell when a check went stale.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  AUDIO_ANALYSIS_FILTER,
  contactSheetFilter,
  type ContactSheetTile,
  type ExportAnalysis,
  type ExportProbe,
  parseAudioAnalysis,
  parseExportProbe,
  parseVideoAnalysis,
  videoAnalysisFilter,
} from "./renderCheck.ts";
import type { Insets } from "./safeZones.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Names the exact text a render check was run against. */
export const timelineFingerprint = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

const run = Effect.fn("timeline.renderProbe.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make(command, args));
});

/** An export's container facts, or null when the file has no picture ffprobe can read. */
export const probeExport = Effect.fn("timeline.renderProbe.probeExport")(function* (file: string) {
  const output = yield* run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,duration:stream_disposition=attached_pic:format=duration",
    "-of",
    "json",
    file,
  ]);
  return parseExportProbe(yield* decodeJson(output));
});

/** Decodes the whole export once for picture and once for sound, at the same time. */
export const analyseExport = Effect.fn("timeline.renderProbe.analyseExport")(function* (
  file: string,
  probe: ExportProbe,
) {
  const base = ["-v", "error", "-nostdin", "-i", file];
  const [picture, sound] = yield* Effect.all(
    [
      run("ffmpeg", [
        ...base,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        videoAnalysisFilter(probe.fps),
        "-f",
        "null",
        "-",
      ]),
      probe.audioCodec === null
        ? Effect.succeed("")
        : run("ffmpeg", [
            ...base,
            "-map",
            "0:a:0",
            "-vn",
            "-af",
            AUDIO_ANALYSIS_FILTER,
            "-f",
            "null",
            "-",
          ]),
    ],
    { concurrency: 2 },
  );
  return {
    ...parseVideoAnalysis(picture, probe),
    ...parseAudioAnalysis(sound, probe.duration),
  } satisfies ExportAnalysis;
});

/**
 * Writes the contact sheet as one JPEG. Returns whether its tiles carry labels: an ffmpeg
 * built without drawtext still makes the sheet, bare.
 */
export const writeContactSheet = Effect.fn("timeline.renderProbe.writeContactSheet")(
  function* (input: {
    readonly file: string;
    readonly output: string;
    readonly tiles: ReadonlyArray<ContactSheetTile>;
    readonly probe: ExportProbe;
    readonly zones?: Insets;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(input.output), { recursive: true });
    const part = `${input.output}.part.jpg`;
    const render = (labels: boolean) =>
      run("ffmpeg", [
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-i",
        input.file,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        contactSheetFilter(input.tiles, input.probe, labels, input.zones),
        "-frames:v",
        "1",
        "-update",
        "1",
        "-q:v",
        "4",
        part,
      ]).pipe(Effect.as(labels));
    const labelled = yield* render(true).pipe(Effect.catch(() => render(false)));
    yield* fs.rename(part, input.output);
    return labelled;
  },
);
