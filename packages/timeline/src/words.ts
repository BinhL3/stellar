/**
 * The words spoken on a timeline, so an agent can cut by what was said. Transcripts time each
 * word in its source file's seconds; here they are placed in timeline frames and numbered.
 *
 *   A1 0-120 #1:0 IMG_8139.MOV
 *   1:Hãy@34 2:subscribe@38 3:cho@67
 */
import { layoutTimeline } from "./layout.ts";
import type { Timeline } from "./otio.ts";

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
}

export interface ClipWords {
  readonly track: string;
  readonly clipId: string;
  readonly name: string;
  readonly startFrame: number;
  readonly endFrame: number;
  /** Null when the clip's media has no transcript. */
  readonly words: ReadonlyArray<TimelineWord> | null;
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
    const sourceStart = start_time.value / start_time.rate;
    const key = `${target}\n${item.startFrame}\n${sourceStart}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const clipStart = Math.round(item.startFrame);
    const clipEnd = Math.round(item.endFrame);
    const frameAt = (seconds: number) =>
      Math.round(item.startFrame + (seconds - sourceStart) * layout.rate);
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
    });
  }
  return { name: timeline.name, rate: layout.rate, count, clips };
};

const LINE_WIDTH = 100;

/** The words as an agent reads them: a line per clip, then its words as `index:word@startFrame`. */
export const wordsText = (view: WordsView): string => {
  const lines = [
    `# ${view.name} · ${view.count} words · frames @${view.rate} · track start-end #clipId name, then index:word@startFrame`,
  ];
  for (const clip of view.clips) {
    const header = `${clip.track} ${clip.startFrame}-${clip.endFrame} #${clip.clipId} ${clip.name}`;
    if (clip.words === null) {
      lines.push(`${header} (no transcript)`);
      continue;
    }
    lines.push(clip.words.length === 0 ? `${header} (no words)` : header);
    let line = "";
    for (const word of clip.words) {
      const entry = `${word.index}:${word.word}@${word.startFrame}`;
      if (line !== "" && line.length + 1 + entry.length > LINE_WIDTH) {
        lines.push(line);
        line = "";
      }
      line = line === "" ? entry : `${line} ${entry}`;
    }
    if (line !== "") lines.push(line);
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
