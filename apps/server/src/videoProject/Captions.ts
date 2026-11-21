/**
 * Captions from a timeline's words: cues broken where the speech breaks, each placed on the
 * stillest band of its frames clear of the apps' buttons, checked against the caption font,
 * and written as an SRT in the project folder for Premiere to import.
 */
import type { VideoCaptionsResult, VideoPlatform } from "@t3tools/contracts";
import { type GrayFrame, placeCaption } from "@t3tools/timeline/captionPlacement";
import {
  breakCaptions,
  captionWords,
  pictureSamples,
  SHORTS_CAPTIONS,
  srtText,
} from "@t3tools/timeline/captions";
import {
  faceIsNamed,
  fileNameMatch,
  fontFaces,
  isVietnamese,
  missingGlyphs,
  VIETNAMESE_LETTERS,
} from "@t3tools/timeline/fontCoverage";
import type { AudioLevels } from "@t3tools/timeline/levels";
import { layoutTimeline } from "@t3tools/timeline/layout";
import { type Timeline, TIMELINE_NAMESPACE } from "@t3tools/timeline/otio";
import type { TextStyle } from "@t3tools/timeline/premiere/textStyle";
import { PROXY_INDEX_PATH, type ProxyIndex } from "@t3tools/timeline/proxies";
import { timelineRenderFacts } from "@t3tools/timeline/renderCheck";
import { safeZoneInsets, safeZoneName } from "@t3tools/timeline/safeZones";
import type { WordsView } from "@t3tools/timeline/words";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const CAPTIONS_FOLDER = "captions";
/** Frames read under each cue, and the size they are read at: enough to see what moves. */
const SAMPLES_PER_CUE = 4;
const SAMPLE_WIDTH = 36;
/** A caption's type, when the timeline shows none, as a share of the frame's height. */
const DEFAULT_TYPE_SHARE = 0.04;
const LINE_HEIGHT = 1.2;
/** A cue up for less than this can't be read. */
const READABLE_SECONDS = 0.4;

export class CaptionsError extends Schema.TaggedError<CaptionsError>()("CaptionsError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The look of the timeline's captions, else of its first text layer: where a font comes from. */
const timelineTextStyle = (timeline: Timeline): TextStyle | undefined => {
  const styles = layoutTimeline(timeline).tracks.flatMap((track) =>
    track.clips.flatMap((item) => {
      const stellar = item.clip.metadata[TIMELINE_NAMESPACE] as
        | { caption?: boolean; textStyle?: TextStyle }
        | undefined;
      return stellar?.textStyle === undefined
        ? []
        : [{ caption: stellar.caption === true, style: stellar.textStyle }];
    }),
  );
  return (styles.find((entry) => entry.caption) ?? styles[0])?.style;
};

/** Where macOS keeps fonts, Adobe Fonts' activated ones included. */
const fontFolders = (home: string) => [
  "/System/Library/Fonts",
  "/Library/Fonts",
  `${home}/Library/Fonts`,
  `${home}/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r`,
];
const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i;

/** The font file holding the face named `name`, and that face; null when none is installed. */
const findFont = Effect.fn("VideoProjects.findFont")(function* (name: string, home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<string> = [];
  for (const folder of fontFolders(home)) {
    const names = yield* fs
      .readDirectory(folder, { recursive: true })
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    for (const file of names) {
      if (FONT_FILE.test(file) && !path.basename(file).startsWith(".")) {
        files.push(path.join(folder, file));
      }
    }
  }
  // Files named like the font are read first; the rest only if none of them holds it.
  const ranked = files
    .map((file) => ({ file, rank: fileNameMatch(path.basename(file), name) }))
    .toSorted((a, b) => b.rank - a.rank);
  for (const { file } of ranked) {
    const bytes = yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => new Uint8Array()));
    const face = fontFaces(bytes).find((candidate) => faceIsNamed(candidate, name));
    if (face !== undefined) return { file, face };
  }
  return null;
});

/** One frame of a media file at `seconds`, small and gray, cropped to the frame's shape. */
const readFrame = Effect.fn("VideoProjects.readCaptionFrame")(function* (
  file: string,
  seconds: number,
  size: { width: number; height: number },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-ss",
      seconds.toFixed(3),
      "-i",
      file,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},format=gray`,
      "-f",
      "rawvideo",
      "-",
    ]),
  );
  const chunks: Array<Uint8Array> = [];
  const [, exitCode] = yield* Effect.all(
    [
      Stream.runForEach(child.stdout, (chunk) => Effect.sync(() => void chunks.push(chunk))),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  const data = new Uint8Array(size.width * size.height);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk.subarray(0, Math.max(0, data.length - at)), at);
    at += chunk.length;
  }
  const frame: GrayFrame = { ...size, data };
  return Number(exitCode) === 0 && at >= data.length ? frame : null;
}, Effect.scoped);

/**
 * Makes the captions of a timeline and writes `captions/<timeline>.srt` in the project folder.
 * Frames are read from the previews where they exist, else from the originals.
 */
export const makeCaptions = Effect.fn("VideoProjects.makeCaptions")(function* (input: {
  readonly projectDir: string;
  readonly timelinePath: string;
  readonly timeline: Timeline;
  readonly view: WordsView;
  readonly levels: ReadonlyMap<string, AudioLevels>;
  readonly home: string;
  readonly platform?: VideoPlatform | undefined;
  readonly font?: string | undefined;
  readonly maxLineChars?: number | undefined;
  readonly maxLines?: number | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const words = captionWords(input.view, input.levels);
  if (words.length === 0) {
    return yield* new CaptionsError({
      reason:
        "The timeline has no transcribed words to caption. Transcribe its clips first (video_transcribe).",
    });
  }
  const facts = timelineRenderFacts(input.timeline);
  const frame = facts.frame ?? { width: 1080, height: 1920 };
  const rules = {
    ...SHORTS_CAPTIONS,
    ...(input.maxLineChars === undefined ? {} : { maxLineChars: input.maxLineChars }),
    ...(input.maxLines === undefined ? {} : { maxLines: input.maxLines }),
  };
  const cues = breakCaptions(
    words,
    facts.cuts.map((cut) => cut.frame),
    facts.rate,
    rules,
  );
  const notes: Array<string> = [];
  const brief = cues.flatMap((cue, position) =>
    (cue.endFrame - cue.startFrame) / facts.rate < READABLE_SECONDS ? [position + 1] : [],
  );
  if (brief.length > 0) {
    notes.push(
      `Cues ${brief.join(", ")} are up for less than ${READABLE_SECONDS} s, too short to read: the transcript gives their words almost no time. Check those words' timings, or merge the cues in Premiere.`,
    );
  }

  const style = timelineTextStyle(input.timeline);
  const typeSize =
    style?.runs.find((run) => run.size !== undefined)?.size ??
    Math.round(frame.height * DEFAULT_TYPE_SHARE);
  const insets = safeZoneInsets(input.platform);
  const mediaRoot = path.dirname(input.projectDir);
  const index = yield* fs.readFileString(path.join(input.projectDir, PROXY_INDEX_PATH)).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((value) => value as ProxyIndex),
    Effect.orElseSucceed(() => null),
  );
  const fileOf = (target: string) => {
    const proxy = index?.media[target]?.video;
    if (proxy !== undefined) return path.join(input.projectDir, proxy);
    return path.isAbsolute(target) ? target : path.join(mediaRoot, target);
  };
  const size = {
    width: SAMPLE_WIDTH,
    height: 2 * Math.round((SAMPLE_WIDTH * frame.height) / frame.width / 2),
  };
  let unread = 0;
  const placed = yield* Effect.forEach(
    cues,
    (cue) =>
      Effect.gen(function* () {
        const frames = yield* Effect.forEach(
          pictureSamples(input.timeline, cue, SAMPLES_PER_CUE),
          (sample) =>
            readFrame(fileOf(sample.target), sample.seconds, size).pipe(
              Effect.orElseSucceed(() => null),
            ),
        );
        const read = frames.filter((one): one is GrayFrame => one !== null);
        unread += frames.length - read.length;
        const height = (cue.lines.length * typeSize * LINE_HEIGHT) / frame.height;
        return { cue, place: placeCaption({ frames: read, insets, height }) };
      }),
    { concurrency: 4 },
  );
  if (unread > 0) {
    notes.push(
      `${unread} frames couldn't be read (is ffmpeg installed, and the footage online?); cues without frames sit at the usual place, low in the clear area.`,
    );
  }

  const fontName = input.font ?? style?.runs.find((run) => run.font !== undefined)?.font;
  const text = cues.flatMap((cue) => cue.lines).join("\n");
  let font: VideoCaptionsResult["font"] = null;
  if (fontName === undefined) {
    notes.push(
      "No caption font was named and the timeline shows none, so glyphs weren't checked: pass `font`.",
    );
  } else {
    const found = yield* findFont(fontName, input.home);
    font =
      found === null
        ? { name: fontName, file: null, missing: [], vietnameseMissing: [] }
        : {
            name: fontName,
            file: found.file,
            missing: missingGlyphs(found.face, text),
            vietnameseMissing: isVietnamese(text)
              ? missingGlyphs(found.face, VIETNAMESE_LETTERS.join(""))
              : [],
          };
  }

  const label = input.timelinePath.replace(/^timelines\/|\.otio$/g, "");
  const srt = path.join(input.projectDir, CAPTIONS_FOLDER, `${label}.srt`);
  yield* fs.makeDirectory(path.dirname(srt), { recursive: true });
  yield* fs.writeFileString(`${srt}.part`, srtText(cues, facts.rate));
  yield* fs.rename(`${srt}.part`, srt);

  return {
    timeline: input.timelinePath,
    srt,
    rate: facts.rate,
    frame,
    zonesFor: safeZoneName(input.platform),
    cues: placed.map(({ cue, place }, position) => ({
      index: position + 1,
      startFrame: cue.startFrame,
      endFrame: cue.endFrame,
      lines: cue.lines,
      x: Number(place.x.toFixed(3)),
      y: Number(place.y.toFixed(3)),
      motion: Number(place.motion.toFixed(1)),
      premiere: { x: Math.round(place.x * frame.width), y: Math.round(place.y * frame.height) },
    })),
    font,
    notes,
  } satisfies VideoCaptionsResult;
});

const clock = (frame: number, rate: number) => {
  const seconds = frame / rate;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
};

/** The captions as an agent reads them: the file, the font check, then a line per cue. */
export const captionsText = (result: VideoCaptionsResult): string => {
  const { font } = result;
  const fontLine =
    font === null
      ? []
      : font.file === null
        ? [`Font: no installed font is named ${font.name}; its glyphs weren't checked.`]
        : [
            font.missing.length === 0
              ? `Font: ${font.name} draws every letter of these captions.`
              : `Font: ${font.name} can't draw ${font.missing.join(" ")} in these captions.`,
            ...(font.vietnameseMissing.length === 0
              ? []
              : [`Font: ${font.name} also lacks Vietnamese ${font.vietnameseMissing.join(" ")}.`]),
          ];
  return [
    `# ${result.cues.length} cues in ${result.srt} · frames @${result.rate} · ${result.frame.width}x${result.frame.height} · clear of ${result.zonesFor}`,
    ...fontLine,
    ...result.notes,
    "# n start-end frames (time) y=centre as a fraction of the height, Premiere position x,y px: lines split by /",
    ...result.cues.map(
      (cue) =>
        `${cue.index} ${cue.startFrame}-${cue.endFrame} (${clock(cue.startFrame, result.rate)}) y=${cue.y} ${cue.premiere.x},${cue.premiere.y}: ${cue.lines.join(" / ")}`,
    ),
  ].join("\n");
};
