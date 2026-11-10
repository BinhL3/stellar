import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  type Clip,
  serializeTimeline,
  TIMELINE_NAMESPACE,
  type Timeline,
  timeRange,
  type Track,
} from "./otio.ts";
import { PROXY_INDEX_PATH, type ProxyIndex } from "./proxies.ts";

/** Where a project keeps what was shot, inside its media root (the Stellar folder's parent). */
export const FOOTAGE_DIRECTORY = "Footage";
/**
 * Every footage clip back to back, written by intake so the footage plays in the Timeline tab
 * before any Premiere project exists. Generated: it is rewritten whenever footage changes.
 */
export const FOOTAGE_TIMELINE_PATH = "timelines/Footage.otio";

const VIDEO_FILE = /\.(mov|mp4|m4v|mxf|avi|mkv|mts|m2ts)$/i;
const STRINGOUT_RATE = 60;

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Video files under the media root's Footage folder, as paths relative to the media root. */
export const listFootage = Effect.fn("timeline.listFootage")(function* (mediaRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs
    .readDirectory(path.join(mediaRoot, FOOTAGE_DIRECTORY), { recursive: true })
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  return names
    .filter((name) => VIDEO_FILE.test(name) && !path.basename(name).startsWith("."))
    .map((name) => `${FOOTAGE_DIRECTORY}/${name.split(path.sep).join("/")}`)
    .toSorted();
});

interface FootageClip {
  readonly target: string;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
}

/** One video and one audio track with every clip in order; odd-sized clips are scaled to fit. */
export const footageStringout = (
  clips: ReadonlyArray<FootageClip>,
  mediaRoot: string,
): Timeline => {
  // The frame is the most common clip size, so a stray horizontal clip doesn't set it.
  const sizes = new Map<string, number>();
  for (const clip of clips) {
    const key = `${clip.width}x${clip.height}`;
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  const [common] = [...sizes].toSorted((a, b) => b[1] - a[1]);
  const [width = 1080, height = 1920] = (common?.[0] ?? "").split("x").map(Number);
  const item = (clip: FootageClip, fit: boolean): Clip => {
    const scale = Math.min(width / clip.width, height / clip.height) * 100;
    return {
      OTIO_SCHEMA: "Clip.2",
      name: clip.target.slice(clip.target.lastIndexOf("/") + 1),
      source_range: timeRange(
        0,
        Math.max(1, Math.round(clip.duration * STRINGOUT_RATE)),
        STRINGOUT_RATE,
      ),
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: "ExternalReference.1",
          target_url: clip.target,
          metadata: {},
        },
      },
      active_media_reference_key: "DEFAULT_MEDIA",
      enabled: true,
      metadata:
        fit && Math.abs(scale - 100) > 0.5
          ? { [TIMELINE_NAMESPACE]: { transform: { scale } } }
          : {},
    };
  };
  const track = (name: string, kind: Track["kind"]): Track => ({
    OTIO_SCHEMA: "Track.1",
    name,
    kind,
    children: clips.map((clip) => item(clip, kind === "Video")),
    enabled: true,
    metadata: {},
  });
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: "Footage",
    global_start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: STRINGOUT_RATE },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      children: [track("V1", "Video"), track("A1", "Audio")],
      enabled: true,
      metadata: {},
    },
    metadata: {
      [TIMELINE_NAMESPACE]: {
        rate: STRINGOUT_RATE,
        frame: { width, height },
        mediaRoot,
        generated: "footage",
      },
    },
  };
};

/**
 * Rewrites the footage timeline from the proxy index, which has each clip's duration and size.
 * Returns whether the file changed. Does nothing while the project has no footage.
 */
export const writeFootageStringout = Effect.fn("timeline.writeFootageStringout")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mediaRoot = path.dirname(path.resolve(projectDir));
  const index = yield* fs.readFileString(path.join(projectDir, PROXY_INDEX_PATH)).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((value) => value as ProxyIndex),
    Effect.orElseSucceed(() => null),
  );
  const clips: Array<FootageClip> = [];
  for (const target of yield* listFootage(mediaRoot)) {
    const entry = index?.media[target];
    if (entry?.video === undefined || entry.width === 0 || entry.height === 0) continue;
    clips.push({ target, duration: entry.duration, width: entry.width, height: entry.height });
  }
  if (clips.length === 0) return false;
  const text = serializeTimeline(footageStringout(clips, mediaRoot));
  const file = path.join(projectDir, FOOTAGE_TIMELINE_PATH);
  const current = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  if (current === text) return false;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, text);
  return true;
});

export class FootageCopyError extends Schema.TaggedError<FootageCopyError>()("FootageCopyError", {
  file: Schema.String,
}) {
  override get message(): string {
    return `${this.file} did not copy completely.`;
  }
}

/**
 * Copies files into a footage folder one at a time, checking each copy's size against its
 * source. A file already there at the right size is left alone, so an import can be re-run.
 */
export const copyFootage = Effect.fn("timeline.copyFootage")(function* (input: {
  readonly sources: ReadonlyArray<string>;
  readonly destination: string;
  readonly onCopied: (done: number) => Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(input.destination, { recursive: true });
  let done = 0;
  for (const source of input.sources) {
    const target = path.join(input.destination, path.basename(source));
    const size = (yield* fs.stat(source)).size;
    const existing = yield* fs.stat(target).pipe(Effect.option);
    if (existing._tag === "None" || existing.value.size !== size) {
      // Copied under another name first, so a copy cut short never passes for the file.
      yield* fs.copyFile(source, `${target}.part`);
      if ((yield* fs.stat(`${target}.part`)).size !== size) {
        return yield* new FootageCopyError({ file: path.basename(source) });
      }
      yield* fs.rename(`${target}.part`, target);
    }
    done += 1;
    yield* input.onCopied(done);
  }
  return done;
});
