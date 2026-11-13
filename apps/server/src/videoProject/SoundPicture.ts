/**
 * Draws a sound picture (see `@t3tools/timeline/soundPicture`) with ffmpeg and keeps it in the
 * project folder's `render/sound/`, where an agent opens it like the render check's contact
 * sheet.
 */
import { applyEdits } from "@t3tools/timeline/edits";
import { layoutTimeline } from "@t3tools/timeline/layout";
import type { Timeline } from "@t3tools/timeline/otio";
import {
  passagePieces,
  soundPictureCommand,
  soundPictureLayout,
  soundPicturePassage,
  type SoundPictureRequest,
  type SoundPictureRowInput,
} from "@t3tools/timeline/soundPicture";
import { timelineWords, type TranscriptWord, type WordsView } from "@t3tools/timeline/words";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

const SOUND_PICTURE_FOLDER = "render/sound";
/** Pictures are named for what they show; the oldest go once the folder holds this many. */
const KEPT_PICTURES = 24;

/**
 * Fonts found on most hosts that cover Vietnamese. One is named to ffmpeg because a label
 * without a font file costs a fontconfig lookup each; with none of these, fontconfig picks.
 */
const LABEL_FONTS = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/noto/NotoSans-Regular.ttf",
];

export class SoundPictureError extends Schema.TaggedError<SoundPictureError>()(
  "SoundPictureError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

const wordsLine = (view: WordsView, range: { readonly start: number; readonly end: number }) =>
  view.clips
    .flatMap((clip) => clip.words ?? [])
    .filter((word) => word.startFrame >= range.start && word.startFrame < range.end)
    .map((word) => `${word.index}:${word.word}@${word.startFrame}`)
    .join(" ");

/**
 * Pictures a passage of `timeline` and returns the image's path with a caption. With a cut, a
 * second row shows the timeline as a ripple removal of those frames would leave it.
 */
export const drawSoundPicture = Effect.fn("VideoProjects.drawSoundPicture")(function* (input: {
  readonly projectDir: string;
  readonly timeline: Timeline;
  readonly transcripts: ReadonlyMap<string, ReadonlyArray<TranscriptWord>>;
  readonly request: SoundPictureRequest;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { rate, durationFrames } = layoutTimeline(input.timeline);
  const view = timelineWords(input.timeline, input.transcripts);
  const passage = soundPicturePassage(view, durationFrames, input.request);
  if (typeof passage === "string") {
    return yield* new SoundPictureError({ reason: `No picture: ${passage}.` });
  }
  const { range, cut } = passage;
  const spoken = (target: string) => input.transcripts.has(target);
  const seconds = (frames: number) => (frames / rate).toFixed(2);
  const allWords = (words: WordsView) => words.clips.flatMap((clip) => clip.words ?? []);
  const rows: Array<SoundPictureRowInput> = [
    {
      title: `Now  frames ${range.start}-${range.end}  ${seconds(range.end - range.start)} s at ${rate} fps${cut === null ? "" : "   red shading comes out"}`,
      range,
      pieces: passagePieces(input.timeline, range, spoken),
      words: allWords(view),
      shaded: cut === null ? [] : [cut],
    },
  ];
  if (cut !== null) {
    const after = applyEdits(input.timeline, [{ kind: "removeRange", ...cut, ripple: true }]);
    const kept = { start: range.start, end: range.end - (cut.end - cut.start) };
    rows.push({
      title: `With frames ${cut.start}-${cut.end} removed and closed up  plays ${seconds(kept.end - kept.start)} s   red line is the join`,
      range: kept,
      pieces: passagePieces(after, kept, spoken),
      words: allWords(timelineWords(after, input.transcripts)),
      cuts: [cut.start],
    });
  }
  const layout = soundPictureLayout(rate, rows);

  const mediaRoot = path.dirname(input.projectDir);
  const targets = [
    ...new Set(layout.rows.flatMap((row) => row.pieces.flatMap((piece) => piece.target ?? []))),
  ];
  if (targets.length === 0) {
    return yield* new SoundPictureError({
      reason: `No picture: no audio clip plays in frames ${range.start}-${range.end}.`,
    });
  }
  // A file with no audio stream would fail the whole graph, so each is asked first.
  const files = new Map<string, string>();
  const silent: Array<string> = [];
  yield* Effect.forEach(
    targets,
    Effect.fnUntraced(function* (target) {
      const file = path.isAbsolute(target) ? target : path.join(mediaRoot, target);
      if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
        silent.push(`${target} is missing`);
        return;
      }
      const streams = yield* spawner
        .string(
          ChildProcess.make("ffprobe", [
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
            file,
          ]),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new SoundPictureError({
                reason: "Could not read the audio. Is ffmpeg installed on this machine?",
                cause,
              }),
          ),
        );
      if (streams.includes("audio")) files.set(target, file);
      else silent.push(`${target} has no audio`);
    }),
    { concurrency: 4 },
  );
  if (files.size === 0) {
    return yield* new SoundPictureError({
      reason: `No picture: nothing to hear in frames ${range.start}-${range.end} (${silent.join(", ")}).`,
    });
  }

  const name = `f${range.start}-${range.end}${cut === null ? "" : `-cut${cut.start}-${cut.end}`}.png`;
  const folder = path.join(input.projectDir, SOUND_PICTURE_FOLDER);
  const output = path.join(folder, name);
  const part = path.join(folder, `.${name}.part.png`);
  let fontFile: string | null = null;
  for (const candidate of LABEL_FONTS) {
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      fontFile = candidate;
      break;
    }
  }
  // Untraced: the two attempts of one drawing, inside its span.
  const render = Effect.fnUntraced(function* (labels: boolean) {
    const { inputs, graph } = soundPictureCommand(
      layout,
      (target) => files.get(target) ?? null,
      labels ? { fontFile } : null,
    );
    yield* fs.remove(part, { force: true });
    yield* spawner.string(
      ChildProcess.make("ffmpeg", [
        "-v",
        "error",
        "-nostdin",
        "-y",
        ...inputs,
        "-filter_complex",
        graph,
        "-map",
        "[out]",
        "-frames:v",
        "1",
        "-update",
        "1",
        part,
      ]),
    );
    // The file is the proof: a failed run may still exit through `string` without error.
    yield* fs.stat(part);
    yield* fs.rename(part, output);
    return labels;
  });
  const labelled = yield* fs.makeDirectory(folder, { recursive: true }).pipe(
    Effect.andThen(render(true).pipe(Effect.catch(() => render(false)))),
    Effect.mapError(
      (cause) =>
        new SoundPictureError({
          reason: "Could not draw the sound picture. Is ffmpeg installed on this machine?",
          cause,
        }),
    ),
  );

  const kept = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed((): Array<string> => []));
  const dated = yield* Effect.forEach(
    kept.filter((entry) => entry.endsWith(".png") && !entry.startsWith(".")),
    (entry) =>
      fs.stat(path.join(folder, entry)).pipe(
        Effect.map((stat) => ({
          entry,
          at: Option.match(stat.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
        })),
        Effect.option,
      ),
  );
  for (const old of dated
    .flatMap(Option.toArray)
    .toSorted((a, b) => b.at - a.at)
    .slice(KEPT_PICTURES)) {
    yield* fs.remove(path.join(folder, old.entry)).pipe(Effect.ignore);
  }

  const heard = [...new Set(layout.rows[0]!.pieces.flatMap((piece) => piece.track ?? []))];
  const caption = [
    `Frames ${range.start}-${range.end} of ${heard.join("+")}: waveform over spectrogram (0-8 kHz upward, brighter is louder), a tick where each word starts, frame numbers along the bottom, white lines where clips join.`,
    ...(cut === null
      ? []
      : [
          `Lower row: the same passage with frames ${cut.start}-${cut.end} removed and closed up, at the same scale.`,
        ]),
    ...(input.transcripts.size === 0 ? ["No transcript here, so no words are drawn."] : []),
    ...(silent.length === 0 ? [] : [`Drawn as silence: ${silent.join(", ")}.`]),
    ...(labelled
      ? []
      : [
          `This ffmpeg can't draw text, so the picture has ticks without labels: x = (frame - ${range.start}) × ${layout.pixelsPerFrame.toFixed(2)} px. Words: ${wordsLine(view, range) || "none"}.`,
        ]),
  ].join(" ");
  return { picture: output, caption };
});
