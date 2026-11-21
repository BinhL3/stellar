// @effect-diagnostics nodeBuiltinImport:off -- Hashing a media file's identity for its proxy key.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { readConformState } from "./conformBuilder.ts";
import { listFootage } from "./footage.ts";
import { checkMediaFile, isAppleDouble } from "./mediaFile.ts";
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
  pngOrientation,
  orientationFilters,
  proxyIdentity,
  rateChangesFrom,
  STILL_PATH,
  STILL_RENDITION_EDGE,
  STRIP_TILE_HEIGHT,
  type StillConverter,
  type StillTools,
  stillConverters,
  stillFormat,
  stripSpacing,
} from "./proxies.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

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
  /** Nominal frames per second, and the average over the whole clip; 0 when unknown. */
  readonly fps: number;
  readonly averageFps: number;
}

const ratio = (text: string | undefined): number => {
  const [top, bottom = "1"] = (text ?? "").split("/");
  const value = Number(top) / Number(bottom);
  return Number.isFinite(value) ? value : 0;
};
// A clip whose average rate is this far off its nominal one has its frame times read in full.
const VARIABLE_RATE_TOLERANCE = 0.001;

// Pixel formats that carry an alpha plane: yuva444p12le, rgba, argb, gbrap and friends.
const ALPHA_PIXEL_FORMAT = /^(yuva|ya\d|rgba|bgra|argb|abgr|gbrap)/;

/** A tool that is missing or that failed on a file, in words the status badge can show. */
export class ProxyToolError extends Schema.TaggedError<ProxyToolError>()("ProxyToolError", {
  tool: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return this.tool === "" ? this.reason : `${this.tool}: ${this.reason}`;
  }
}

const REASON_LIMIT = 240;
const isToolError = Schema.is(ProxyToolError);
const reasonOf = (error: unknown) => (isToolError(error) ? error.message : String(error));

/** Runs a tool to its end and returns its output; a non-zero exit fails with what it printed. */
const run = Effect.fn("timeline.proxies.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.gen(function* () {
    const handle = yield* spawner.spawn(ChildProcess.make(command, args));
    const [output, errors, exit] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: 3 },
    );
    if (Number(exit) === 0) return output;
    const lines = errors.split("\n").filter((line) => line.trim() !== "");
    return yield* new ProxyToolError({
      tool: command,
      reason: (lines.slice(-2).join(" ").trim() || `exited with code ${exit}`).slice(-REASON_LIMIT),
    });
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      PlatformError: (error) =>
        Effect.fail(
          new ProxyToolError({
            tool: command,
            reason: error.reason._tag === "NotFound" ? "is not installed" : error.message,
          }),
        ),
    }),
  );
});

const installed = (command: string, args: ReadonlyArray<string>) =>
  run(command, args).pipe(
    Effect.as(true),
    Effect.catch((error) => Effect.succeed(error.reason !== "is not installed")),
  );

const probe = Effect.fn("timeline.proxies.probe")(function* (file: string) {
  const output = yield* run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,width,height,pix_fmt,r_frame_rate,avg_frame_rate:stream_disposition=attached_pic:stream_side_data=rotation:stream_tags=rotate:format=duration",
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
      r_frame_rate?: string;
      avg_frame_rate?: string;
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
    fps: ratio(video?.r_frame_rate),
    averageFps: ratio(video?.avg_frame_rate),
  } satisfies Probe;
});

const entryOutputs = (entry: ProxyEntry) =>
  [entry.video, entry.strip?.file, entry.audio, entry.peaks, entry.still].filter(
    (output) => output !== undefined,
  );

/** Whether an entry was made by a build that recorded everything, and all its outputs exist. */
const complete = Effect.fn("timeline.proxies.complete")(function* (
  previous: ProxyEntry,
  projectDir: string,
) {
  if (previous.alpha === undefined) return false;
  if (previous.video !== undefined && previous.fps === undefined) return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const output of entryOutputs(previous)) {
    if (!(yield* fs.exists(path.join(projectDir, output)))) return false;
  }
  return true;
});

const hashKey = (identity: string, size: unknown, modified: number) =>
  NodeCrypto.createHash("sha256")
    .update(`${identity}|${size}|${modified}`)
    .digest("hex")
    .slice(0, 16);

interface BuildTools extends StillTools {
  /** ffmpeg was built with libwebp; without it renditions are PNG. */
  readonly webp: boolean;
}

/**
 * Makes the picture the player draws for a still no browser decodes. The tool that reads the
 * file writes a PNG, which keeps alpha, and ffmpeg turns it upright, sizes it and encodes it.
 */
const buildStill = Effect.fn("timeline.proxies.buildStill")(function* (input: {
  readonly source: string;
  readonly projectDir: string;
  readonly key: string;
  readonly tools: BuildTools;
  readonly edge?: number;
  readonly quality?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const format = stillFormat(input.source);
  if (format === null) return yield* new ProxyToolError({ tool: "", reason: "Not a still." });
  const plan = stillConverters(format, input.tools);
  if ("reason" in plan) return yield* new ProxyToolError({ tool: "", reason: plan.reason });
  const still = `${PROXY_DIRECTORY}/${input.key}.still.${input.tools.webp ? "webp" : "png"}`;
  const final = path.join(input.projectDir, still);
  const partial = path.join(
    input.projectDir,
    `${PROXY_DIRECTORY}/${input.key}.still.part.${input.tools.webp ? "webp" : "png"}`,
  );
  const decoded = path.join(input.projectDir, `${PROXY_DIRECTORY}/${input.key}.decoded.part.png`);
  const edge = input.edge ?? STILL_RENDITION_EDGE;

  const convert = Effect.fn("timeline.proxies.convertStill")(function* (tool: StillConverter) {
    let picture = input.source;
    let size: { readonly width: number; readonly height: number } | null = null;
    let filters: ReadonlyArray<string> = [];
    if (tool === "sips") {
      const described = yield* run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", input.source]);
      const width = Number(/pixelWidth: (\d+)/.exec(described)?.[1] ?? 0);
      const height = Number(/pixelHeight: (\d+)/.exec(described)?.[1] ?? 0);
      yield* run("sips", [
        "-Z",
        String(edge),
        "-s",
        "format",
        "png",
        input.source,
        "--out",
        decoded,
      ]);
      const orientation = pngOrientation(yield* fs.readFile(decoded));
      filters = orientationFilters(orientation);
      size = orientation >= 5 ? { width: height, height: width } : { width, height };
      picture = decoded;
    } else if (tool !== "ffmpeg") {
      yield* run(tool, [input.source, decoded]);
      picture = decoded;
    }
    const info = yield* probe(picture);
    size ??= { width: info.width, height: info.height };
    if (size.width === 0 || size.height === 0) {
      return yield* new ProxyToolError({ tool, reason: "read no picture from the file" });
    }
    yield* run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      picture,
      "-vf",
      [
        ...filters,
        `scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease`,
      ].join(","),
      "-frames:v",
      "1",
      "-update",
      "1",
      ...(input.tools.webp ? ["-c:v", "libwebp", "-q:v", String(input.quality ?? 88)] : []),
      partial,
    ]);
    yield* fs.rename(partial, final);
    return {
      key: input.key,
      width: size.width,
      height: size.height,
      duration: 0,
      alpha: info.hasAlpha,
      still,
    } satisfies ProxyEntry;
  });

  const reasons: Array<string> = [];
  for (const tool of plan.converters) {
    const made = yield* convert(tool).pipe(
      Effect.catch((error) => {
        reasons.push(reasonOf(error));
        return Effect.succeed(null);
      }),
      Effect.ensuring(Effect.ignore(fs.remove(decoded, { force: true }))),
    );
    if (made !== null) return made;
  }
  return yield* new ProxyToolError({
    tool: "",
    reason: `No tool could read this still (${reasons.join("; ")}).`,
  });
});

const buildEntry = Effect.fn("timeline.proxies.buildEntry")(function* (input: {
  readonly target: string;
  readonly source: string;
  /** The file's path under the media root, which the key is made from. */
  readonly identity: string;
  readonly projectDir: string;
  readonly previous: ProxyEntry | undefined;
  readonly previousByKey: ReadonlyMap<string, ProxyEntry>;
  /** The previous index keyed proxies by absolute path; an entry that still fits is adopted. */
  readonly legacyKeys: boolean;
  readonly tools: Effect.Effect<BuildTools, never, ChildProcessSpawner.ChildProcessSpawner>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found = yield* fs.stat(input.source).pipe(Effect.option);
  if (Option.isNone(found)) {
    // Proxies outlive their originals going offline: an unplugged drive keeps its previews.
    if (input.previous !== undefined && (yield* complete(input.previous, input.projectDir))) {
      return input.previous;
    }
    return yield* new ProxyToolError({
      tool: "",
      reason: "The file is missing or its drive is offline.",
    });
  }
  const problem = yield* checkMediaFile(input.source);
  if (problem !== null) return yield* new ProxyToolError({ tool: "", reason: problem });
  const stat = found.value;
  const modified = Option.match(stat.mtime, { onNone: () => 0, onSome: (d) => d.getTime() });
  // Whole seconds: a copy to exFAT keeps a file's time only to 10 ms.
  const key = hashKey(input.identity, stat.size, Math.floor(modified / 1000));
  const previous = input.previous ?? input.previousByKey.get(key);
  const usable = previous !== undefined && (yield* complete(previous, input.projectDir));
  if (usable && previous.key === key) return previous;
  if (stillFormat(input.source) !== null) {
    return yield* buildStill({
      source: input.source,
      projectDir: input.projectDir,
      key,
      tools: yield* input.tools,
    });
  }
  // The old key held the absolute path, so it only matches while the drive is where it was.
  if (usable && input.legacyKeys && previous.key === hashKey(input.source, stat.size, modified)) {
    return { ...previous, key };
  }
  const info = yield* probe(input.source);
  if (
    usable &&
    input.legacyKeys &&
    Math.abs(previous.duration - info.duration) < 0.001 &&
    previous.width === info.width &&
    previous.height === info.height
  ) {
    // The drive moved, so the old key can't be checked; the same file at the same place under
    // the media root with the same length and size is taken to be the one the proxy was made of.
    return { ...previous, key };
  }
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
    entry.fps = Math.round(info.fps * 1000) / 1000;
    if (info.fps > 0 && Math.abs(info.averageFps - info.fps) / info.fps > VARIABLE_RATE_TOLERANCE) {
      // Reads every packet's time without decoding; only clips that look variable pay for it.
      const times = (yield* run("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts_time",
        "-of",
        "csv=p=0",
        input.source,
      ]))
        .split("\n")
        .map(Number)
        .filter((time) => Number.isFinite(time) && time >= 0);
      const changes = rateChangesFrom(times);
      if (changes.length > 0) entry.rateChanges = changes;
    }
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
        // The player reads this file by byte range and plays it at 48 kHz: the index goes
        // first so one request opens it, and the rate matches so nothing is resampled.
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
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

// Every file a build writes is named by a 16-digit key; nothing else in the folder is touched.
const PROXY_FILE = /^[0-9a-f]{16}\.[a-z0-9.]+$/;
const UNFINISHED_FILE = /\.part\.[a-z0-9]+$|\.pcm$/;
const UNFINISHED_GRACE_MS = 60 * 60 * 1000;

/**
 * Removes proxy files no index entry points at: those of media that left the project or
 * changed. A half-written file is left for an hour, since another build may be writing it.
 */
const removeOrphans = Effect.fn("timeline.proxies.removeOrphans")(function* (
  projectDir: string,
  entries: ReadonlyArray<ProxyEntry>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(projectDir, PROXY_DIRECTORY);
  const kept = new Set(entries.flatMap(entryOutputs).map((output) => path.basename(output)));
  const now = yield* Clock.currentTimeMillis;
  let removed = 0;
  for (const name of yield* fs.readDirectory(directory)) {
    if (!PROXY_FILE.test(name) || kept.has(name)) continue;
    const file = path.join(directory, name);
    const stat = yield* fs.stat(file).pipe(Effect.option);
    if (Option.isNone(stat) || stat.value.type !== "File") continue;
    if (UNFINISHED_FILE.test(name)) {
      const written = Option.match(stat.value.mtime, {
        onNone: () => now,
        onSome: (d) => d.getTime(),
      });
      if (now - written < UNFINISHED_GRACE_MS) continue;
    }
    yield* fs.remove(file);
    removed += 1;
  }
  return removed;
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
    ...(previous?.keys === undefined ? {} : { keys: previous.keys }),
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
  const files = (yield* fs
    .readDirectory(timelineDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []))).filter(
    (f) => f.endsWith(".otio") && !f.startsWith("."),
  );
  const targets = new Map<string, { readonly source: string; readonly identity: string }>();
  const mediaRoot = path.dirname(projectDir);
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
        if (target === "" || targets.has(target) || isAppleDouble(target)) continue;
        // Stills a browser draws are played from the original file.
        if (STILL_PATH.test(target) && stillFormat(target) === null) continue;
        const identity = proxyIdentity(
          target,
          root === undefined ? [mediaRoot] : [root, mediaRoot],
        );
        if (path.isAbsolute(target)) targets.set(target, { source: target, identity });
        else if (root !== undefined)
          targets.set(target, { source: path.join(root, target), identity });
      }
    }
  }
  // Footage gets proxies as soon as it lands, before any timeline uses it. Its keys are the
  // same media-root-relative paths a pulled timeline stores, so both share one proxy.
  // An original with a conformed copy is cut from the copy, so only the copy gets a proxy.
  const { copyOf } = (yield* readConformState(projectDir)).state;
  for (const target of yield* listFootage(mediaRoot)) {
    if (!targets.has(target) && !copyOf.has(target)) {
      targets.set(target, { source: path.join(mediaRoot, target), identity: target });
    }
  }
  yield* fs.makeDirectory(path.join(projectDir, PROXY_DIRECTORY), { recursive: true });
  const indexPath = path.join(projectDir, PROXY_INDEX_PATH);
  const previous = yield* fs.readFileString(indexPath).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((value) => ((value as ProxyIndex).version === 1 ? (value as ProxyIndex) : null)),
    Effect.orElseSucceed(() => null),
  );
  // Without these every file would fail one by one with nothing to say why.
  const absent: Array<string> = [];
  const encoders = yield* run("ffmpeg", ["-hide_banner", "-encoders"]).pipe(
    Effect.catch((error) => {
      if (error.reason === "is not installed") absent.push("ffmpeg");
      return Effect.succeed("");
    }),
  );
  if (!(yield* installed("ffprobe", ["-version"]))) absent.push("ffprobe");
  if (absent.length > 0) {
    const error = `${absent.join(" and ")} ${absent.length === 1 ? "is" : "are"} not installed on the machine that holds this project, so no previews can be made. Install ffmpeg (it includes ffprobe) and sync again.`;
    const index: ProxyIndex = {
      version: 1,
      media: previous?.media ?? {},
      ...(previous?.keys === undefined ? {} : { keys: previous.keys }),
      error,
    };
    yield* fs.writeFileString(`${indexPath}.part`, serializeJson(index));
    yield* fs.rename(`${indexPath}.part`, indexPath);
    return { indexPath, count: Object.keys(index.media).length, failed: 0, error };
  }
  // Only a project with stills to convert pays for looking up the tools that read them.
  const tools = yield* Effect.cached(
    Effect.gen(function* () {
      const sips = yield* installed("sips", ["--version"]);
      const heif = (yield* installed("heif-dec", ["--version"]))
        ? ("heif-dec" as const)
        : (yield* installed("heif-convert", ["--version"]))
          ? ("heif-convert" as const)
          : null;
      return { webp: /\blibwebp\b/.test(encoders), sips, heif } satisfies BuildTools;
    }),
  );
  const previousByKey = new Map(
    Object.values(previous?.media ?? {}).map((entry) => [entry.key, entry]),
  );
  yield* report({ kind: "start", total: targets.size });
  const media: Record<string, ProxyEntry> = {};
  const failures: Record<string, string> = {};
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
          keys: 2,
          ...(building ? { building: { done, total: targets.size } } : {}),
          ...(failed > 0 ? { failed, failures: { ...failures } } : {}),
        };
        yield* fs.writeFileString(`${indexPath}.part`, serializeJson(index));
        yield* fs.rename(`${indexPath}.part`, indexPath);
      }),
    );
  yield* Effect.forEach(
    [...targets],
    ([target, { source, identity }]) =>
      buildEntry({
        target,
        source,
        identity,
        projectDir,
        previous: previous?.media[target],
        previousByKey,
        legacyKeys: previous !== null && previous.keys === undefined,
        tools,
      }).pipe(
        Effect.map((entry) => ({ entry, error: undefined })),
        Effect.catch((error) =>
          Effect.succeed({
            entry: null,
            // Tools name the file by its full path; the badge already names it.
            error: reasonOf(error)
              .replaceAll(`${source}: `, "")
              .replaceAll(source, path.basename(source))
              .slice(0, REASON_LIMIT * 2),
          }),
        ),
        Effect.tap(({ entry, error }) => {
          done += 1;
          if (entry === null) {
            failed += 1;
            failures[target] = error ?? "";
          } else media[target] = entry;
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
  const removed = yield* removeOrphans(projectDir, Object.values(media)).pipe(
    Effect.orElseSucceed(() => 0),
  );
  return { indexPath, count: Object.keys(media).length, failed, removed };
});

/**
 * A carousel photo's drawable copy keeps the original's size, so an export resamples the
 * photo once; this is only the largest picture a WebP can hold.
 */
const PHOTO_RENDITION_EDGE = 16383;

/**
 * A carousel photo's upright size and the file a browser draws for it. A still no browser
 * decodes (HEIC, TIFF, PSD, raw) gets a near-lossless copy in the proxies folder, at its own
 * size to export from; the video proxies' 1600 px renditions are not. Others are drawn as they are.
 */
export const preparePhoto = Effect.fn("timeline.proxies.preparePhoto")(function* (input: {
  readonly source: string;
  readonly projectDir: string;
  /** The photo's path under the media root, which names its copy. */
  readonly identity: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (stillFormat(input.source) === null) {
    const info = yield* probe(input.source);
    return { width: info.width, height: info.height, still: null };
  }
  const stat = yield* fs.stat(input.source);
  const modified = Option.match(stat.mtime, {
    onNone: () => 0,
    onSome: (date) => date.getTime(),
  });
  yield* fs.makeDirectory(path.join(input.projectDir, PROXY_DIRECTORY), { recursive: true });
  const encoders = yield* run("ffmpeg", ["-hide_banner", "-encoders"]);
  const heif = (yield* installed("heif-dec", ["--version"]))
    ? ("heif-dec" as const)
    : (yield* installed("heif-convert", ["--version"]))
      ? ("heif-convert" as const)
      : null;
  const entry = yield* buildStill({
    source: input.source,
    projectDir: input.projectDir,
    key: `photo-${hashKey(input.identity, stat.size, Math.floor(modified / 1000))}`,
    tools: {
      webp: /\blibwebp\b/.test(encoders),
      sips: yield* installed("sips", ["--version"]),
      heif,
    },
    edge: PHOTO_RENDITION_EDGE,
    quality: 96,
  });
  return { width: entry.width, height: entry.height, still: entry.still };
});
