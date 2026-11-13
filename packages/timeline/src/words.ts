/**
 * The words spoken on a timeline, so an agent can cut by what was said. Transcripts time each
 * word in its source file's seconds; here they are placed in timeline frames and numbered.
 *
 *   A1 0-120 #1:0 IMG_8139.MOV
 *   1:Hãy@34 2:subscribe@38 3:cho@67
 */
import { type AudioLevels, gapSound } from "./levels.ts";
import { layoutTimeline } from "./layout.ts";
import type { Timeline } from "./otio.ts";
import { offsetAtSourceSeconds, sourceSecondsAt, timeScalarOf } from "./speed.ts";

/** One word of a transcript, timed in seconds of its source file. */
export interface TranscriptWord {
  readonly w: string;
  readonly start: number;
  readonly end: number;
}

export interface TimelineWord {
  /** 1-based, counted across the whole timeline. */
  readonly index: number;
  readonly word: string;
  readonly startFrame: number;
  /** Where the next word in the clip starts, so cutting a word takes the pause after it too. */
  readonly endFrame: number;
  /** The word's own timing, in seconds of its source. */
  readonly start: number;
  readonly end: number;
}

/** How a clip's frames map to its source, so an edge can be measured where it lands. */
export interface ClipSource {
  readonly target: string;
  /** The clip's first frame, unrounded, and the source second heard there. */
  readonly startFrame: number;
  readonly startSeconds: number;
  /** Source seconds per timeline second; never negative here. */
  readonly scalar: number;
}

/** The source second a clip plays at a timeline frame. */
export const sourceSecondsOfFrame = (source: ClipSource, frame: number, rate: number): number =>
  source.startSeconds + ((frame - source.startFrame) / rate) * source.scalar;

/** The timeline frame, unrounded, at which a clip plays a source second. */
export const frameOfSourceSeconds = (source: ClipSource, seconds: number, rate: number): number =>
  source.startFrame + ((seconds - source.startSeconds) / source.scalar) * rate;

export interface ClipWords {
  readonly track: string;
  readonly clipId: string;
  readonly name: string;
  readonly startFrame: number;
  readonly endFrame: number;
  /** Null when the clip's media has no transcript, or `unplaced` says why they aren't listed. */
  readonly words: ReadonlyArray<TimelineWord> | null;
  /** Why a clip with a transcript lists no words, such as "plays in reverse". */
  readonly unplaced?: string;
  /** Null when the clip plays backwards. */
  readonly source: ClipSource | null;
}

export interface WordsView {
  readonly name: string;
  readonly rate: number;
  readonly count: number;
  readonly clips: ReadonlyArray<ClipWords>;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * The words audible on the timeline: for each enabled clip on an audio track, the words of its
 * media's transcript (keyed by `target_url`) that start inside the clip's source range.
 * A word belongs to the clip by its rounded frame, so a cut at a word's frame takes the word.
 */
export const timelineWords = (
  timeline: Timeline,
  transcripts: ReadonlyMap<string, ReadonlyArray<TranscriptWord>>,
): WordsView => {
  const layout = layoutTimeline(timeline);
  const placed = layout.tracks
    .filter((track) => track.kind === "Audio")
    .flatMap((track) =>
      track.clips.filter((item) => item.clip.enabled).map((item) => ({ track: track.name, item })),
    )
    .toSorted((a, b) => a.item.startFrame - b.item.startFrame);
  // A file's channels often sit on two tracks as linked clips; its words are listed once.
  const seen = new Set<string>();
  let count = 0;
  const clips: Array<ClipWords> = [];
  for (const { track, item } of placed) {
    const { start_time } = item.clip.source_range;
    const target = item.clip.media_references.DEFAULT_MEDIA.target_url;
    const scalar = timeScalarOf(item.clip);
    // The first source second heard, which for a sped-up clip still is the source start.
    const sourceStart =
      scalar === 1 ? start_time.value / start_time.rate : sourceSecondsAt(item.clip, 0);
    const key = `${target}\n${item.startFrame}\n${sourceStart}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const clipStart = Math.round(item.startFrame);
    const clipEnd = Math.round(item.endFrame);
    const frameAt = (seconds: number) =>
      scalar === 1
        ? Math.round(item.startFrame + (seconds - sourceStart) * layout.rate)
        : Math.round(item.startFrame + offsetAtSourceSeconds(item.clip, seconds) * layout.rate);
    // Backwards speech has no words to cut by, and a word's end would come before its start.
    if (scalar < 0 && transcripts.has(target)) {
      clips.push({
        track,
        clipId: item.key,
        name: item.clip.name,
        startFrame: clipStart,
        endFrame: clipEnd,
        words: null,
        unplaced: "plays in reverse",
        source: null,
      });
      continue;
    }
    const heard = transcripts.get(target)?.filter((word) => {
      const frame = frameAt(word.start);
      return frame >= clipStart && frame < clipEnd;
    });
    const words = heard?.map((word, position): TimelineWord => {
      const startFrame = frameAt(word.start);
      const next = heard[position + 1];
      return {
        index: count + position + 1,
        word: word.w,
        startFrame,
        endFrame:
          next === undefined ? clamp(frameAt(word.end), startFrame, clipEnd) : frameAt(next.start),
        start: word.start,
        end: word.end,
      };
    });
    count += words?.length ?? 0;
    clips.push({
      track,
      clipId: item.key,
      name: item.clip.name,
      startFrame: clipStart,
      endFrame: clipEnd,
      words: words ?? null,
      source: { target, startFrame: item.startFrame, startSeconds: sourceStart, scalar },
    });
  }
  return { name: timeline.name, rate: layout.rate, count, clips };
};

const LINE_WIDTH = 100;
/** A gap between two words is described from this length; adapted from Scarlet (Forward-Future, MIT). */
export const GAP_SECONDS = 0.4;
/** Words in one page of the text, so a long timeline is read in parts. */
export const WORDS_PAGE = 1500;

/** What a gap of `GAP_SECONDS` or more between two words of a clip holds, as one token. */
export const gapToken = (
  clip: ClipWords,
  before: TimelineWord,
  after: TimelineWord,
  rate: number,
  levels: ReadonlyMap<string, AudioLevels>,
): string | null => {
  if (clip.source === null) return null;
  const heard = (after.start - before.end) / clip.source.scalar;
  if (heard < GAP_SECONDS) return null;
  const measured = levels.get(clip.source.target);
  const sound =
    measured === undefined
      ? undefined
      : gapSound(measured, { start: before.end, end: after.start });
  if (sound === undefined) return `(${heard.toFixed(2)}s unmeasured)`;
  if (sound.runs.length === 0) return `(${heard.toFixed(2)}s quiet)`;
  const { source } = clip;
  const runs = sound.runs.map(
    (run) =>
      `${Math.round(frameOfSourceSeconds(source, run.start, rate))}-${Math.round(frameOfSourceSeconds(source, run.end, rate))}`,
  );
  return `(${heard.toFixed(2)}s, ${(sound.seconds / source.scalar).toFixed(2)}s sound @${runs.join(",")})`;
};

/**
 * The words as an agent reads them: a line per clip, then its words as `index:word@startFrame`,
 * with what each gap of `GAP_SECONDS` or more holds. `fromWord` and `limit` page it.
 */
export const wordsText = (
  view: WordsView,
  options: {
    readonly levels?: ReadonlyMap<string, AudioLevels>;
    readonly fromWord?: number;
    readonly limit?: number;
  } = {},
): string => {
  const levels = options.levels ?? new Map<string, AudioLevels>();
  const first = Math.max(1, Math.floor(options.fromWord ?? 1));
  const last = first + Math.max(1, Math.floor(options.limit ?? WORDS_PAGE)) - 1;
  const lines = [
    `# ${view.name} · ${view.count} words · frames @${view.rate} · track start-end #clipId name, then index:word@startFrame; (seconds) is a gap of ${GAP_SECONDS}s or more and what sounds in it`,
  ];
  let passed = 0;
  for (const clip of view.clips) {
    const header = `${clip.track} ${clip.startFrame}-${clip.endFrame} #${clip.clipId} ${clip.name}`;
    const here = passed + 1 >= first && passed < last;
    if (clip.words === null) {
      if (here) lines.push(`${header} (${clip.unplaced ?? "no transcript"})`);
      continue;
    }
    passed += clip.words.length;
    if (clip.words.length === 0) {
      if (here) lines.push(`${header} (no words)`);
      continue;
    }
    if (!clip.words.some((word) => word.index >= first && word.index <= last)) continue;
    lines.push(header);
    let line = "";
    const add = (entry: string) => {
      if (line !== "" && line.length + 1 + entry.length > LINE_WIDTH) {
        lines.push(line);
        line = "";
      }
      line = line === "" ? entry : `${line} ${entry}`;
    };
    for (const [position, word] of clip.words.entries()) {
      if (word.index < first || word.index > last) continue;
      const previous = clip.words[position - 1];
      const gap = previous === undefined ? null : gapToken(clip, previous, word, view.rate, levels);
      if (gap !== null) add(gap);
      add(`${word.index}:${word.word}@${word.startFrame}`);
    }
    if (line !== "") lines.push(line);
  }
  if (first > 1 || last < view.count) {
    lines.push(
      last < view.count
        ? `# words ${first}-${last} of ${view.count}; read on with from ${last + 1}`
        : `# words ${first}-${view.count} of ${view.count}`,
    );
  }
  return lines.join("\n");
};

/**
 * The timeline frames words `fromWord` to `toWord` (inclusive) cover, as `removeRange` takes
 * them, or why there are none.
 */
export const wordRange = (
  view: WordsView,
  fromWord: number,
  toWord: number,
): { readonly start: number; readonly end: number } | string => {
  if (fromWord > toWord) return `fromWord ${fromWord} is after toWord ${toWord}`;
  const all = view.clips.flatMap((clip) => clip.words ?? []);
  for (const index of [fromWord, toWord]) {
    if (!Number.isInteger(index) || index < 1 || index > all.length) {
      return `no word ${index} (the timeline has ${all.length} words)`;
    }
  }
  const chosen = all.slice(fromWord - 1, toWord);
  const start = Math.min(...chosen.map((word) => word.startFrame));
  const end = Math.max(...chosen.map((word) => word.endFrame));
  // Transcripts sometimes give several words one instant; a cut needs frames to remove.
  if (end <= start) {
    return `words ${fromWord}-${toWord} have no length in the transcript (all at frame ${start}); widen the range or use removeRange`;
  }
  return { start, end };
};
