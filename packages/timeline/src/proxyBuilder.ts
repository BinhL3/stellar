// @effect-diagnostics nodeBuiltinImport:off -- Hashing a media file's identity for its proxy key.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
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
  /** The picture has transparency, as generated graphics in ProRes 4444 do. */
  readonly hasAlpha: boolean;
}

// Pixel formats that carry an alpha plane: yuva444p12le, rgba, argb, gbrap and friends.
const ALPHA_PIXEL_FORMAT = /^(yuva|ya\d|rgba|bgra|argb|abgr|gbrap)/;

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
    "stream=codec_type,width,height,pix_fmt:stream_disposition=attached_pic:stream_side_data=rotation:stream_tags=rotate:format=duration",
    "-of",
    "json",
    file,
  ]);
  const parsed = (yield* decodeJson(output)) as {
    streams?: ReadonlyArray<{
      codec_type?: string;
      width?: number;
      height?: number;
      pix_fmt?: string;
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
    hasAlpha: ALPHA_PIXEL_FORMAT.test(video?.pix_fmt ?? ""),
  } satisfies Probe;
});

/** Whether a previous build's entry still describes this file and all its outputs exist. */
const reusable = Effect.fn("timeline.proxies.reusable")(function* (
  previous: ProxyEntry | undefined,
  key: string,
  projectDir: string,
) {
  if (previous === undefined || previous.key !== key || previous.alpha === undefined) return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputs = [previous.video, previous.strip?.file, previous.audio, previous.peaks];
  for (const output of outputs) {
    if (output !== undefined && !(yield* fs.exists(path.join(projectDir, output)))) return false;
  }
  return true;
});

const buildEntry = Effect.fn("timeline.proxies.buildEntry")(function* (input: {
  readonly target: string;
  readonly source: string;
  readonly projectDir: string;
  readonly previous: ProxyEntry | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fs.stat(input.source);
  const modified = Option.match(stat.mtime, { onNone: () => 0, onSome: (d) => d.getTime() });
  const key = NodeCrypto.createHash("sha256")
    .update(`${input.source}|${stat.size}|${modified}`)
    .digest("hex")
    .slice(0, 16);
  if (input.previous !== undefined && (yield* reusable(input.previous, key, input.projectDir))) {
    return input.previous;
  }
  const info = yield* probe(input.source);
  const out = (suffix: string) => `${PROXY_DIRECTORY}/${key}${suffix}`;
  const abs = (relative: string) => path.join(input.projectDir, relative);
  const missing = (relative: string) => Effect.map(fs.exists(abs(relative)), (ok) => !ok);
  const entry: { -readonly [K in keyof ProxyEntry]: ProxyEntry[K] } = {
    key,
    width: info.width,
    height: info.height,
    duration: info.duration,
    alpha: info.hasAlpha,
  };

  // Every output comes from one ffmpeg run, so the source (often 4K HEVC on an external drive)
  // is read and decoded once. Outputs are written under `.part` names and renamed when the run
  // succeeds, so a build that is killed midway never leaves a truncated proxy behind.
  const filters: Array<string> = [];
  const outputs: Array<string> = [];
  const finished: Array<readonly [part: string, final: string]> = [];
  const part = (final: string) => {
    const extension = path.extname(final);
    const partial = `${final.slice(0, -extension.length)}.part${extension}`;
    finished.push([abs(partial), abs(final)]);
    return abs(partial);
  };

  if (info.hasVideo && !STILL_PATH.test(input.source)) {
    // H.264 has no alpha, so a transparent graphic would play on a black box; those get VP9.
    entry.video = out(info.hasAlpha ? ".webm" : ".mp4");
    const { every, count } = stripSpacing(info.duration);
    const tileHeight = STRIP_TILE_HEIGHT;
    const tileWidth = Math.max(2, Math.round((tileHeight * info.width) / info.height / 2) * 2);
    entry.strip = { file: out(".strip.jpg"), every, count, tileWidth, tileHeight };
    const wantVideo = yield* missing(entry.video);
    const wantStrip = yield* missing(entry.strip.file);
    // Autorotation runs before the filters, so iw and ih are the display size.
    const scale = `scale='if(gt(iw,ih),${PROXY_LONG_EDGE},-2)':'if(gt(iw,ih),-2,${PROXY_LONG_EDGE})'[proxy]`;
    const strip = `fps=1/${every},scale=${tileWidth}:${tileHeight},tile=${count}x1[strip]`;
    if (wantVideo && wantStrip) {
      filters.push(`[0:v:0]split=2[full][small]`, `[full]${scale}`, `[small]${strip}`);
    } else if (wantVideo) filters.push(`[0:v:0]${scale}`);
    else if (wantStrip) filters.push(`[0:v:0]${strip}`);
    if (wantVideo) {
      outputs.push(
        "-map",
        "[proxy]",
        "-an",
        ...(info.hasAlpha
          ? [
              "-c:v",
              "libvpx-vp9",
              "-pix_fmt",
              "yuva420p",
              // Alternate reference frames can't carry alpha.
              "-auto-alt-ref",
              "0",
              "-b:v",
              "0",
              "-crf",
              "30",
              "-deadline",
              "realtime",
              "-cpu-used",
              "6",
              "-row-mt",
              "1",
            ]
          : [
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              "26",
              "-pix_fmt",
              "yuv420p",
              "-keyint_min",
              String(PROXY_GOP),
              "-sc_threshold",
              "0",
              "-movflags",
              "+faststart",
            ]),
        "-g",
        String(PROXY_GOP),
        part(entry.video),
      );
    }
    if (wantStrip) {
      outputs.push("-map", "[strip]", "-frames:v", "1", "-q:v", "6", part(entry.strip.file));
    }
  }

  let pcm: string | null = null;
  if (info.hasAudio) {
    entry.audio = out(".m4a");
    entry.peaks = out(".peaks.json");
    if (yield* missing(entry.audio)) {
      outputs.push(
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ac",
        "2",
        part(entry.audio),
      );
    }
    if (yield* missing(entry.peaks)) {
      pcm = abs(out(".pcm"));
      outputs.push(
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
      );
    }
  }

  if (outputs.length > 0) {
    yield* run("ffmpeg", [
      "-v",
      "error",
      "-y",
      // Hardware decode where the machine has it (about twice as fast on 4K HEVC); ffmpeg falls
      // back to software by itself where it doesn't.
      "-hwaccel",
      "auto",
      "-i",
      input.source,
      ...(filters.length > 0 ? ["-filter_complex", filters.join(";")] : []),
      ...outputs,
    ]);
    if (pcm !== null && entry.peaks !== undefined) {
      const peaks = peaksFromPcm(yield* fs.readFile(pcm), PEAK_SAMPLE_RATE / PEAKS_PER_SECOND);
      yield* fs.remove(pcm);
      yield* fs.writeFileString(
        abs(entry.peaks),
        serializeJson({ perSecond: PEAKS_PER_SECOND, peaks }),
      );
    }
    for (const [partial, final] of finished) yield* fs.rename(partial, final);
  }
  return entry;
});

/**
 * Marks the index as building before a build is started in the background, so a client that
 * reads it straight away knows to keep reading until the build's last write clears the mark.
 */
export const markProxiesBuilding = Effect.fn("timeline.markProxiesBuilding")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const indexPath = path.join(projectDir, PROXY_INDEX_PATH);
  const previous = yield* fs.readFileString(indexPath).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((value) => ((value as ProxyIndex).version === 1 ? (value as ProxyIndex) : null)),
    Effect.orElseSucceed(() => null),
  );
  if (previous?.building !== undefined) return;
  yield* fs.makeDirectory(path.join(projectDir, PROXY_DIRECTORY), { recursive: true });
  const index: ProxyIndex = {
    version: 1,
    media: previous?.media ?? {},
    building: { done: 0, total: 0 },
  };
  yield* fs.writeFileString(`${indexPath}.part`, serializeJson(index));
  yield* fs.rename(`${indexPath}.part`, indexPath);
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
  const indexPath = path.join(projectDir, PROXY_INDEX_PATH);
  const previous = yield* fs.readFileString(indexPath).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((value) => ((value as ProxyIndex).version === 1 ? (value as ProxyIndex) : null)),
    Effect.orElseSucceed(() => null),
  );
  yield* report({ kind: "start", total: targets.size });
  const media: Record<string, ProxyEntry> = {};
  let done = 0;
  let failed = 0;
  // The index is rewritten as each file finishes, so the player picks proxies up one by one
  // instead of playing originals until the whole build ends. Renamed into place, so a reader
  // never sees half a file.
  const writing = yield* Semaphore.make(1);
  const writeIndex = (building: boolean) =>
    writing.withPermits(1)(
      Effect.gen(function* () {
        const index: ProxyIndex = {
          version: 1,
          media: { ...media },
          ...(building ? { building: { done, total: targets.size } } : {}),
          ...(failed > 0 ? { failed } : {}),
        };
        yield* fs.writeFileString(`${indexPath}.part`, serializeJson(index));
        yield* fs.rename(`${indexPath}.part`, indexPath);
      }),
    );
  yield* Effect.forEach(
    [...targets],
    ([target, source]) =>
      buildEntry({ target, source, projectDir, previous: previous?.media[target] }).pipe(
        Effect.map((entry) => ({ entry, error: undefined })),
        Effect.catch((error) => Effect.succeed({ entry: null, error: String(error) })),
        Effect.tap(({ entry, error }) => {
          done += 1;
          if (entry === null) failed += 1;
          else media[target] = entry;
          return Effect.andThen(
            report({
              kind: "file",
              target,
              done,
              total: targets.size,
              ...(error === undefined ? {} : { error }),
            }),
            done < targets.size ? writeIndex(true) : Effect.void,
          );
        }),
      ),
    { concurrency: input.concurrency, discard: true },
  );
  yield* writeIndex(false);
  return { indexPath, count: Object.keys(media).length, failed };
});
