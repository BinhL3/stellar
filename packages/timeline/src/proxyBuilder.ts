// @effect-diagnostics nodeBuiltinImport:off -- Hashing a media file's identity for its proxy key.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { serializeJson, TIMELINE_NAMESPACE, type Timeline } from "./otio.ts";
import {
  PEAKS_PER_SECOND,
  PROXY_DIRECTORY,
  PROXY_GOP,
  PROXY_INDEX_PATH,
  PROXY_LONG_EDGE,
  type ProxyEntry,
  type ProxyIndex,
  peaksFromPcm,
  STRIP_TILE_HEIGHT,
  stripSpacing,
} from "./proxies.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const STILL_PATH = /\.(png|jpe?g|heic|tiff?|psd|gif|webp|bmp)$/i;
// Peaks are read from mono PCM at this rate; 40 samples per peak at 50 peaks a second.
const PEAK_SAMPLE_RATE = 2000;

interface Probe {
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
}

const run = Effect.fn("timeline.proxies.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make(command, args));
});

const probe = Effect.fn("timeline.proxies.probe")(function* (file: string) {
  const output = yield* run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,width,height:stream_disposition=attached_pic:stream_side_data=rotation:stream_tags=rotate:format=duration",
    "-of",
    "json",
    file,
  ]);
  const parsed = (yield* decodeJson(output)) as {
    streams?: ReadonlyArray<{
      codec_type?: string;
      width?: number;
      height?: number;
      tags?: { rotate?: string };
      disposition?: { attached_pic?: number };
      side_data_list?: ReadonlyArray<{ rotation?: number }>;
    }>;
    format?: { duration?: string };
  };
  const streams = parsed.streams ?? [];
  // Audio files can carry cover art as a one-frame "video" stream.
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const rotation = Math.abs(
    Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) ||
      Number(video?.tags?.rotate ?? 0),
  );
  const turned = rotation % 180 === 90;
  return {
    width: (turned ? video?.height : video?.width) ?? 0,
    height: (turned ? video?.width : video?.height) ?? 0,
    duration: Number(parsed.format?.duration ?? 0),
    hasVideo: video !== undefined,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  } satisfies Probe;
});

const buildEntry = Effect.fn("timeline.proxies.buildEntry")(function* (input: {
  readonly target: string;
  readonly source: string;
  readonly projectDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fs.stat(input.source);
  const modified = Option.match(stat.mtime, { onNone: () => 0, onSome: (d) => d.getTime() });
  const key = NodeCrypto.createHash("sha256")
    .update(`${input.source}|${stat.size}|${modified}`)
    .digest("hex")
    .slice(0, 16);
  const info = yield* probe(input.source);
  const out = (suffix: string) => `${PROXY_DIRECTORY}/${key}${suffix}`;
  const abs = (relative: string) => path.join(input.projectDir, relative);
  const missing = (relative: string) => Effect.map(fs.exists(abs(relative)), (ok) => !ok);
  const entry: { -readonly [K in keyof ProxyEntry]: ProxyEntry[K] } = {
    key,
    width: info.width,
    height: info.height,
    duration: info.duration,
  };

  if (info.hasVideo && !STILL_PATH.test(input.source)) {
    entry.video = out(".mp4");
    if (yield* missing(entry.video)) {
      // Autorotation runs before the filter, so iw and ih are the display size.
      yield* run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-i",
        input.source,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `scale='if(gt(iw,ih),${PROXY_LONG_EDGE},-2)':'if(gt(iw,ih),-2,${PROXY_LONG_EDGE})'`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "26",
        "-pix_fmt",
        "yuv420p",
        "-g",
        String(PROXY_GOP),
        "-keyint_min",
        String(PROXY_GOP),
        "-sc_threshold",
        "0",
        "-movflags",
        "+faststart",
        abs(entry.video),
      ]);
    }
    const { every, count } = stripSpacing(info.duration);
    const tileHeight = STRIP_TILE_HEIGHT;
    const tileWidth = Math.max(2, Math.round((tileHeight * info.width) / info.height / 2) * 2);
    entry.strip = { file: out(".strip.jpg"), every, count, tileWidth, tileHeight };
    if (yield* missing(entry.strip.file)) {
      yield* run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-i",
        input.source,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `fps=1/${every},scale=${tileWidth}:${tileHeight},tile=${count}x1`,
        "-frames:v",
        "1",
        "-q:v",
        "6",
        abs(entry.strip.file),
      ]);
    }
  }

  if (info.hasAudio) {
    entry.audio = out(".m4a");
    if (yield* missing(entry.audio)) {
      yield* run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-i",
        input.source,
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ac",
        "2",
        abs(entry.audio),
      ]);
    }
    entry.peaks = out(".peaks.json");
    if (yield* missing(entry.peaks)) {
      const pcm = abs(out(".pcm"));
      yield* run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-i",
        input.source,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(PEAK_SAMPLE_RATE),
        "-f",
        "s16le",
        pcm,
      ]);
      const peaks = peaksFromPcm(yield* fs.readFile(pcm), PEAK_SAMPLE_RATE / PEAKS_PER_SECOND);
      yield* fs.remove(pcm);
      yield* fs.writeFileString(
        abs(entry.peaks),
        serializeJson({ perSecond: PEAKS_PER_SECOND, peaks }),
      );
    }
  }
  return entry;
});

export type ProxyProgress =
  | { readonly kind: "start"; readonly total: number }
  | {
      readonly kind: "file";
      readonly target: string;
      readonly done: number;
      readonly total: number;
      readonly error?: string;
    };

/**
 * Makes proxies, thumbnail strips and waveforms for every media file the project's timelines use,
 * skipping outputs that already exist, then writes `proxies/index.json`.
 */
export const buildProjectProxies = Effect.fn("timeline.buildProjectProxies")(function* (input: {
  readonly projectDir: string;
  readonly concurrency: number;
  readonly onProgress?: (progress: ProxyProgress) => Effect.Effect<void>;
}) {
  const report = input.onProgress ?? (() => Effect.void);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = path.resolve(input.projectDir);
  const timelineDir = path.join(projectDir, "timelines");
  const files = (yield* fs.readDirectory(timelineDir)).filter((f) => f.endsWith(".otio"));
  const targets = new Map<string, string>();
  for (const file of files) {
    const timeline = (yield* decodeJson(
      yield* fs.readFileString(path.join(timelineDir, file)),
    )) as Timeline;
    const root = (timeline.metadata[TIMELINE_NAMESPACE] as { mediaRoot?: string } | undefined)
      ?.mediaRoot;
    for (const track of timeline.tracks.children) {
      for (const child of track.children) {
        if (child.OTIO_SCHEMA !== "Clip.2") continue;
        const target = child.media_references.DEFAULT_MEDIA.target_url;
        if (target === "" || STILL_PATH.test(target) || targets.has(target)) continue;
        if (path.isAbsolute(target)) targets.set(target, target);
        else if (root !== undefined) targets.set(target, path.join(root, target));
      }
    }
  }
  yield* fs.makeDirectory(path.join(projectDir, PROXY_DIRECTORY), { recursive: true });
  yield* report({ kind: "start", total: targets.size });
  let done = 0;
  const entries = yield* Effect.forEach(
    [...targets],
    ([target, source]) =>
      buildEntry({ target, source, projectDir }).pipe(
        Effect.map((entry) => ({ result: [target, entry] as const, error: undefined })),
        Effect.catch((error) => Effect.succeed({ result: null, error: String(error) })),
        Effect.tap(({ error }) => {
          done += 1;
          return report({
            kind: "file",
            target,
            done,
            total: targets.size,
            ...(error === undefined ? {} : { error }),
          });
        }),
        Effect.map(({ result }) => result),
      ),
    { concurrency: input.concurrency },
  );
  const index: ProxyIndex = {
    version: 1,
    media: Object.fromEntries(entries.filter((e) => e !== null)),
  };
  yield* fs.writeFileString(path.join(projectDir, PROXY_INDEX_PATH), serializeJson(index));
  return {
    indexPath: path.join(projectDir, PROXY_INDEX_PATH),
    count: Object.keys(index.media).length,
  };
});
