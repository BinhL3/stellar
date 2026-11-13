/**
 * A passage's sound as a picture for agents, who are never passed audio: waveform over
 * spectrogram, words at their frames, and optionally the passage again with a range removed.
 * Layout and the ffmpeg graph that draws it. Adapted from Scarlet, Forward-Future, MIT.
 */
import { placeWordCut } from "./joins.ts";
import { layoutTimeline } from "./layout.ts";
import type { AudioLevels } from "./levels.ts";
import type { Timeline } from "./otio.ts";
import { sourceSecondsAt, timeScalarOf } from "./speed.ts";
import { type TimelineWord, wordRange, type WordsView } from "./words.ts";

/** The longest passage one picture holds: past this a word is too narrow to read. */
export const SOUND_PICTURE_MAX_SECONDS = 15;

const WIDTH = 1280;
const TITLE = 22;
const WAVE = 110;
const LABEL_LANE = 17;
const LABEL_LANES = 2;
const LABELS = 6 + LABEL_LANE * LABEL_LANES;
const SPECTRUM = 190;
const AXIS = 20;
const ROW = TITLE + WAVE + LABELS + SPECTRUM + AXIS;
const FONT_SIZE = 13;
/** Width of a label character at `FONT_SIZE`, wide enough that drawn labels don't touch. */
const CHAR_WIDTH = 7.5;
const SAMPLE_RATE = 16000;

export interface FrameRange {
  readonly start: number;
  readonly end: number;
}

/** What to picture, in timeline frames or `video_timeline_words` numbers. */
export interface SoundPictureRequest {
  readonly fromWord?: number | undefined;
  readonly toWord?: number | undefined;
  readonly start?: number | undefined;
  readonly end?: number | undefined;
  readonly cutFromWord?: number | undefined;
  readonly cutToWord?: number | undefined;
  readonly cutStart?: number | undefined;
  readonly cutEnd?: number | undefined;
}

/** Seconds shown either side of the words asked for, and of a cut pictured on its own. */
const WORD_CONTEXT_SECONDS = 0.5;
const CUT_CONTEXT_SECONDS = 1.5;

/**
 * The frames a request pictures and the frames it would cut, or why it can't be drawn. A cut
 * named by words is placed as `removeWords` places it, on the quiet `levels` measured, and
 * `cutNote` says where; without levels it is the word timings.
 */
export const soundPicturePassage = (
  view: WordsView,
  durationFrames: number,
  request: SoundPictureRequest,
  levels: ReadonlyMap<string, AudioLevels> = new Map(),
):
  | { readonly range: FrameRange; readonly cut: FrameRange | null; readonly cutNote: string | null }
  | string => {
  const frames = (start: number | undefined, end: number | undefined, what: string) => {
    if (start === undefined && end === undefined) return null;
    if (start === undefined || end === undefined) return `${what} needs both a start and an end`;
    const range = {
      start: Math.round(Math.min(start, end)),
      end: Math.round(Math.max(start, end)),
    };
    return range.end > range.start ? range : `${what} has no length`;
  };
  const words = (from: number | undefined, to: number | undefined) =>
    from === undefined && to === undefined ? null : wordRange(view, from ?? to!, to ?? from!);
  const { cutFromWord, cutToWord } = request;
  const placed =
    cutFromWord === undefined && cutToWord === undefined
      ? null
      : placeWordCut(view, levels, cutFromWord ?? cutToWord!, cutToWord ?? cutFromWord!);
  if (typeof placed === "string") return placed;
  const cut =
    placed === null
      ? frames(request.cutStart, request.cutEnd, "the cut")
      : { start: placed.start, end: placed.end };
  if (typeof cut === "string") return cut;
  const cutNote = placed?.note ?? null;
  const asked = frames(request.start, request.end, "the passage");
  if (typeof asked === "string") return asked;
  const spoken = words(request.fromWord, request.toWord);
  if (typeof spoken === "string") return spoken;
  const around = (range: FrameRange, seconds: number) => ({
    start: range.start - Math.round(seconds * view.rate),
    end: range.end + Math.round(seconds * view.rate),
  });
  const wanted =
    asked ??
    (spoken === null ? null : around(spoken, WORD_CONTEXT_SECONDS)) ??
    (cut === null ? null : around(cut, CUT_CONTEXT_SECONDS));
  if (wanted === null) {
    return "say what to picture: fromWord and toWord, start and end frames, or a cut";
  }
  const range = {
    start: Math.max(0, wanted.start),
    end: Math.min(Math.round(durationFrames), wanted.end),
  };
  if (range.end <= range.start) {
    return `frames ${wanted.start}-${wanted.end} are outside the timeline (0-${Math.round(durationFrames)})`;
  }
  const seconds = (range.end - range.start) / view.rate;
  if (seconds > SOUND_PICTURE_MAX_SECONDS) {
    return `a sound picture holds at most ${SOUND_PICTURE_MAX_SECONDS} seconds (${Math.round(SOUND_PICTURE_MAX_SECONDS * view.rate)} frames here) and frames ${range.start}-${range.end} are ${seconds.toFixed(1)}; picture a shorter passage`;
  }
  if (cut === null) return { range, cut: null, cutNote };
  const inside = { start: Math.max(cut.start, range.start), end: Math.min(cut.end, range.end) };
  if (inside.end <= inside.start) {
    return `the cut (frames ${cut.start}-${cut.end}) is outside the passage (frames ${range.start}-${range.end})`;
  }
  if (inside.end - inside.start >= range.end - range.start) {
    return "the cut takes the whole passage; picture more around it";
  }
  return { range, cut: inside, cutNote };
};

/** A stretch of a passage that plays one source without a break, or nothing (`target` null). */
export interface SoundPiece {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly track: string | null;
  readonly target: string | null;
  /** The media it plays in seconds of its source, lowest first whatever the direction. */
  readonly sourceStart: number;
  readonly sourceEnd: number;
  /** The clip's time scalar: 2 plays twice as fast, negative plays backwards. */
  readonly speed: number;
}

/**
 * The audio a passage plays, piece by piece. One clip is heard at a time so speech stays
 * readable under music: a clip whose media `spoken` says has a transcript, else the one on the
 * first audio track. Pieces cut from one clip that play straight on are one piece.
 */
export const passagePieces = (
  timeline: Timeline,
  range: FrameRange,
  spoken: (target: string) => boolean,
): ReadonlyArray<SoundPiece> => {
  const layout = layoutTimeline(timeline);
  const clips = layout.tracks
    .filter((track) => track.kind === "Audio")
    .flatMap((track) =>
      track.clips
        .filter((item) => item.clip.enabled)
        .map((item) => ({
          track: track.name,
          item,
          target: item.clip.media_references.DEFAULT_MEDIA.target_url,
        })),
    )
    .filter(({ item }) => item.endFrame > range.start && item.startFrame < range.end);
  const edges = [
    ...new Set([
      range.start,
      range.end,
      ...clips
        .flatMap(({ item }) => [item.startFrame, item.endFrame])
        .filter((frame) => frame > range.start && frame < range.end),
    ]),
  ].toSorted((a, b) => a - b);
  const pieces: Array<SoundPiece> = [];
  for (let index = 0; index + 1 < edges.length; index++) {
    const startFrame = edges[index]!;
    const endFrame = edges[index + 1]!;
    const playing = clips.filter(
      ({ item }) => item.startFrame <= startFrame && item.endFrame >= endFrame,
    );
    const heard = playing.find(({ target }) => spoken(target)) ?? playing[0];
    const previous = pieces.at(-1);
    if (heard === undefined || heard.target === "") {
      if (previous !== undefined && previous.target === null) {
        pieces[pieces.length - 1] = { ...previous, endFrame };
      } else {
        pieces.push({
          startFrame,
          endFrame,
          track: null,
          target: null,
          sourceStart: 0,
          sourceEnd: 0,
          speed: 1,
        });
      }
      continue;
    }
    const { clip } = heard.item;
    const from = sourceSecondsAt(clip, (startFrame - heard.item.startFrame) / layout.rate);
    const to = sourceSecondsAt(clip, (endFrame - heard.item.startFrame) / layout.rate);
    const piece: SoundPiece = {
      startFrame,
      endFrame,
      track: heard.track,
      target: heard.target,
      sourceStart: Math.min(from, to),
      sourceEnd: Math.max(from, to),
      speed: timeScalarOf(clip),
    };
    const playsOn =
      previous !== undefined &&
      previous.target === piece.target &&
      previous.speed === piece.speed &&
      Math.abs((piece.speed > 0 ? previous.sourceEnd : previous.sourceStart) - from) <
        0.5 / layout.rate;
    if (playsOn) {
      pieces[pieces.length - 1] = {
        ...previous,
        endFrame,
        sourceStart: Math.min(previous.sourceStart, piece.sourceStart),
        sourceEnd: Math.max(previous.sourceEnd, piece.sourceEnd),
      };
    } else {
      pieces.push(piece);
    }
  }
  return pieces;
};

export interface SoundPictureRowInput {
  readonly title: string;
  readonly range: FrameRange;
  readonly pieces: ReadonlyArray<SoundPiece>;
  readonly words: ReadonlyArray<TimelineWord>;
  /** Frames shaded red: what a cut would take out. */
  readonly shaded?: ReadonlyArray<FrameRange>;
  /** Frames where a cut joins what it kept, drawn as red lines. */
  readonly cuts?: ReadonlyArray<number>;
}

export interface SoundPictureRow {
  readonly title: string;
  readonly range: FrameRange;
  readonly top: number;
  /** Pixels the sound covers, from x 0. */
  readonly width: number;
  readonly pieces: ReadonlyArray<SoundPiece>;
  /** Where one piece ends and the next begins: a clip edge, or `cut`, the join a removal leaves. */
  readonly joins: ReadonlyArray<{ readonly x: number; readonly cut: boolean }>;
  readonly shaded: ReadonlyArray<{ readonly x: number; readonly width: number }>;
  readonly ticks: ReadonlyArray<{ readonly x: number; readonly frame: number }>;
  /** Every word gets a tick at `x`; `lane` is null when its label had no room. */
  readonly words: ReadonlyArray<{
    readonly x: number;
    readonly lane: number | null;
    readonly text: string;
  }>;
}

export interface SoundPictureLayout {
  readonly rate: number;
  readonly width: number;
  readonly height: number;
  readonly pixelsPerFrame: number;
  readonly rows: ReadonlyArray<SoundPictureRow>;
}

/** Text drawtext takes inside quotes: the filter graph's own punctuation comes out. */
const plain = (text: string) =>
  text
    .replace(/'/g, "’")
    .replace(/[^\p{L}\p{N} .?!’-]/gu, "")
    .trim();

/**
 * Where everything in the picture goes. Rows share one scale, set by the first, so a row with
 * a range removed is shorter by exactly what came out.
 */
export const soundPictureLayout = (
  rate: number,
  rows: ReadonlyArray<SoundPictureRowInput>,
): SoundPictureLayout => {
  const first = rows[0]?.range ?? { start: 0, end: 1 };
  const pixelsPerFrame = WIDTH / Math.max(1, first.end - first.start);
  const seconds = (first.end - first.start) / rate;
  const step = Math.max(1, Math.round((seconds > 8 ? 1 : seconds > 3 ? 0.5 : 0.25) * rate));
  return {
    rate,
    width: WIDTH,
    height: ROW * rows.length,
    pixelsPerFrame,
    rows: rows.map((row, rowIndex): SoundPictureRow => {
      const x = (frame: number) => Math.round((frame - row.range.start) * pixelsPerFrame);
      const width = Math.min(WIDTH, Math.max(16, x(row.range.end)));
      const inside = (frame: number) => frame > row.range.start && frame < row.range.end;
      const cuts = (row.cuts ?? []).filter(inside);
      const ticks: Array<{ x: number; frame: number }> = [];
      for (let frame = Math.ceil(row.range.start / step) * step; frame < row.range.end;) {
        ticks.push({ x: x(frame), frame });
        frame += step;
      }
      const free = Array.from({ length: LABEL_LANES }, () => 0);
      const words = row.words
        .filter((word) => word.startFrame >= row.range.start && word.startFrame < row.range.end)
        .map((word) => {
          const at = x(word.startFrame);
          const text = `${word.index} ${plain(word.word)}`;
          const lane = free.findIndex((taken) => at >= taken);
          if (lane >= 0) free[lane] = at + 8 + Math.ceil(text.length * CHAR_WIDTH);
          return { x: at, lane: lane < 0 ? null : lane, text };
        });
      return {
        title: row.title,
        range: row.range,
        top: rowIndex * ROW,
        width,
        pieces: row.pieces,
        joins: [
          ...row.pieces
            .slice(1)
            .map((piece) => piece.startFrame)
            .filter((frame) => !cuts.some((cut) => Math.abs(cut - frame) < 0.5))
            .map((frame) => ({ x: x(frame), cut: false })),
          ...cuts.map((frame) => ({ x: x(frame), cut: true })),
        ].toSorted((a, b) => a.x - b.x),
        shaded: (row.shaded ?? [])
          .map((range) => ({
            start: Math.max(range.start, row.range.start),
            end: Math.min(range.end, row.range.end),
          }))
          .filter((range) => range.end > range.start)
          .map((range) => ({
            x: x(range.start),
            width: Math.max(1, x(range.end) - x(range.start)),
          })),
        ticks,
        words,
      };
    }),
  };
};

/** `atempo` takes 0.5 to 100 per instance, so a slower clip chains several. */
const tempoFilters = (speed: number): ReadonlyArray<string> => {
  const filters: Array<string> = [];
  let left = Math.abs(speed);
  while (left < 0.5) {
    filters.push("atempo=0.5");
    left /= 0.5;
  }
  while (left > 100) {
    filters.push("atempo=100");
    left /= 100;
  }
  if (Math.abs(left - 1) > 1e-6) filters.push(`atempo=${left.toFixed(6)}`);
  return filters;
};

/**
 * The ffmpeg inputs and filter graph drawing a layout into `[out]`. A piece whose `fileOf` is
 * null plays as silence. With `labels` null (no drawtext) only ticks and lines are drawn. Name
 * a `fontFile`: without one each label costs a fontconfig lookup, tens of milliseconds.
 */
export const soundPictureCommand = (
  layout: SoundPictureLayout,
  fileOf: (target: string) => string | null,
  labels: { readonly fontFile: string | null } | null,
): { readonly inputs: ReadonlyArray<string>; readonly graph: string } => {
  const inputs: Array<string> = [];
  const chains: Array<string> = [];
  const draw: Array<string> = [];
  let inputCount = 0;
  const box = (x: number, y: number, w: number, h: number, colour: string) =>
    `drawbox=x=${x}:y=${y}:w=${Math.max(1, w)}:h=${h}:color=${colour}:t=fill`;
  const text = (value: string, x: number, y: number, colour: string) =>
    `drawtext=${labels?.fontFile ? `fontfile=${labels.fontFile}:` : ""}expansion=none:text='${plain(value)}':fontsize=${FONT_SIZE}:fontcolor=${colour}:x=${Math.max(2, x)}:y=${y}`;
  layout.rows.forEach((row, r) => {
    const body = WAVE + LABELS + SPECTRUM;
    row.pieces.forEach((piece, p) => {
      const length = ((piece.endFrame - piece.startFrame) / layout.rate).toFixed(5);
      const file = piece.target === null ? null : fileOf(piece.target);
      if (file === null) {
        chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=mono,atrim=end=${length}[r${r}p${p}]`);
        return;
      }
      inputs.push(
        "-ss",
        piece.sourceStart.toFixed(5),
        "-t",
        (piece.sourceEnd - piece.sourceStart).toFixed(5),
        "-i",
        file,
      );
      chains.push(
        [
          `[${inputCount++}:a:0]aresample=${SAMPLE_RATE}`,
          "aformat=sample_fmts=fltp:channel_layouts=mono",
          ...(piece.speed < 0 ? ["areverse"] : []),
          ...tempoFilters(piece.speed),
          // Padded then trimmed, so a source that runs short still fills its place in the row.
          `apad,atrim=end=${length},asetpts=PTS-STARTPTS[r${r}p${p}]`,
        ].join(","),
      );
    });
    const joined = row.pieces.map((_, p) => `[r${r}p${p}]`).join("");
    chains.push(
      `${joined}${row.pieces.length > 1 ? `concat=n=${row.pieces.length}:v=0:a=1,` : ""}asplit=2[wa${r}][sa${r}]`,
      `[wa${r}]showwavespic=s=${row.width}x${WAVE}:colors=0xe8e8e8:scale=sqrt[w${r}]`,
      `[sa${r}]showspectrumpic=s=${row.width}x${SPECTRUM}:legend=0:scale=log:color=intensity[s${r}]`,
    );
    const top = row.top + TITLE;
    for (const shade of row.shaded) draw.push(box(shade.x, top, shade.width, body, "red@0.18"));
    for (const tick of row.ticks) {
      draw.push(box(tick.x, top, 1, body, "white@0.12"));
      if (labels !== null)
        draw.push(text(String(tick.frame), tick.x + 3, top + body + 3, "0x999999"));
    }
    for (const join of row.joins) {
      draw.push(box(join.x - 1, top, 2, body, join.cut ? "red" : "white@0.8"));
    }
    for (const word of row.words) {
      draw.push(box(word.x, top + WAVE, 1, 6, "0xbbbbbb"));
      if (labels !== null && word.lane !== null) {
        draw.push(text(word.text, word.x + 2, top + WAVE + 6 + word.lane * LABEL_LANE, "0xe8e8e8"));
      }
    }
    if (labels !== null) draw.push(text(row.title, 6, row.top + 4, "0xaaaaaa"));
  });
  chains.push(`color=c=0x101010:s=${layout.width}x${layout.height}:d=1:r=1[bg]`);
  let canvas = "bg";
  layout.rows.forEach((row, r) => {
    chains.push(
      `[${canvas}][w${r}]overlay=0:${row.top + TITLE}[c${r}w]`,
      `[c${r}w][s${r}]overlay=0:${row.top + TITLE + WAVE + LABELS}[c${r}s]`,
    );
    canvas = `c${r}s`;
  });
  chains.push(`[${canvas}]${draw.length === 0 ? "null" : draw.join(",")}[out]`);
  return { inputs, graph: chains.join(";") };
};
