/**
 * Caption cues from a timeline's words for a vertical short: each gap between words is scored
 * for how natural a break it is, and the cues break at the best gaps. A picture cut always ends
 * a cue, and the words are never changed, dropped or shortened.
 */
import { gapSound, type AudioLevels } from "./levels.ts";
import { layoutTimeline } from "./layout.ts";
import { type Timeline, TIMELINE_NAMESPACE } from "./otio.ts";
import { sourceSecondsAt } from "./speed.ts";
import { frameOfSourceSeconds, type WordsView } from "./words.ts";

/** A spoken word as a caption shows it, in timeline frames. */
export interface CaptionWord {
  readonly text: string;
  readonly startFrame: number;
  /** Where its sound ends; the next word may start later. */
  readonly endFrame: number;
  /** Whether the gap after it is quiet in the audio; null when not measured or across clips. */
  readonly quietAfter: boolean | null;
}

/** How the gap after each word is weighed; the weights add up to 1. */
export const BREAK_WEIGHTS = { gap: 0.2, audio: 0.4, punctuation: 0.3, phraseStart: 0.1 } as const;
/** A gap this long or longer scores fully as a pause. */
const FULL_PAUSE_SECONDS = 0.5;

// Words that open a clause, after which a reader expects a new line. Lowercase, NFC.
const PHRASE_STARTERS = new Set([
  "and",
  "but",
  "or",
  "so",
  "because",
  "cause",
  "then",
  "when",
  "while",
  "if",
  "unless",
  "which",
  "who",
  "that",
  "until",
  "after",
  "before",
  "since",
  "although",
  "though",
  "nhưng",
  "vì",
  "thì",
  "mà",
  "nên",
  "và",
  "hay",
  "hoặc",
  "rồi",
  "khi",
  "nếu",
  "để",
  "còn",
  "tại",
  "bởi",
  "tuy",
  "vậy",
]);

// Vietnamese particles that end a spoken sentence.
const SENTENCE_PARTICLES = new Set([
  "ạ",
  "ấy",
  "nhé",
  "nha",
  "nhỉ",
  "à",
  "hả",
  "chứ",
  "thôi",
  "đó",
  "đấy",
]);

// Words that lean on the next one: a line never wants to end on them.
const LEANING = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "by",
  "from",
  "my",
  "your",
  "của",
  "những",
  "các",
  "một",
  "cho",
  "với",
  "ở",
  "trong",
]);
const LEANING_COST = 0.3;

const bare = (word: string) =>
  word
    .normalize("NFC")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** How natural a break is between `before` and `after`, 0 to 1. */
export const breakScore = (
  before: string,
  after: string,
  gapSeconds: number,
  quiet: boolean | null,
): number => {
  const gap = Math.min(1, Math.max(0, gapSeconds) / FULL_PAUSE_SECONDS);
  // Unmeasured audio says nothing of its own, so the gap stands in for it.
  const audio = quiet === null ? gap : quiet ? 1 : 0;
  // Transcripts often leave sentences unpunctuated, but capitalise the word that opens one,
  // and spoken Vietnamese closes one with a particle.
  const punctuation = /[.!?…]["'”’)\]]*$/.test(before)
    ? 1
    : /[,;:–—]["'”’)\]]*$/.test(before) || SENTENCE_PARTICLES.has(bare(before))
      ? 0.6
      : /^\p{Lu}\p{Ll}/u.test(after)
        ? 0.5
        : 0;
  // "nhưng mà", "bởi vì", "and so": the second word belongs to the first.
  const phraseStart =
    PHRASE_STARTERS.has(bare(after)) && !PHRASE_STARTERS.has(bare(before)) ? 1 : 0;
  return (
    BREAK_WEIGHTS.gap * gap +
    BREAK_WEIGHTS.audio * audio +
    BREAK_WEIGHTS.punctuation * punctuation +
    BREAK_WEIGHTS.phraseStart * phraseStart
  );
};

/** The timeline's words in the order they are heard, each with where its sound ends. */
export const captionWords = (
  view: WordsView,
  levels: ReadonlyMap<string, AudioLevels>,
): Array<CaptionWord> => {
  const placed = view.clips
    .flatMap((clip) =>
      (clip.words ?? []).map((word, position) => ({
        clip,
        word,
        next: clip.words?.[position + 1],
      })),
    )
    .toSorted((a, b) => a.word.startFrame - b.word.startFrame || a.word.index - b.word.index);
  return placed.map(({ clip, word, next }) => {
    const source = clip.source;
    const soundEnd =
      source === null
        ? word.endFrame
        : Math.round(frameOfSourceSeconds(source, word.end, view.rate));
    const endFrame = Math.min(Math.max(soundEnd, word.startFrame + 1), clip.endFrame);
    const measured = source === null ? undefined : levels.get(source.target);
    const sound =
      next === undefined || measured === undefined
        ? undefined
        : gapSound(measured, { start: word.end, end: next.start });
    return {
      text: word.word.trim(),
      startFrame: word.startFrame,
      endFrame,
      quietAfter: sound === undefined ? null : sound.runs.length === 0,
    };
  });
};

export interface CaptionRules {
  /** Characters a line holds at most; a single longer word still gets a line of its own. */
  readonly maxLineChars: number;
  /** 1 or 2. */
  readonly maxLines: number;
  /** A cue runs at most this long, unless it is one word. */
  readonly maxCueSeconds: number;
}

/**
 * Binh's captions: his own SRTs hold one line per cue, 18 characters at the median and 25 at
 * the 90th percentile, about a second each. A second line is allowed, at a cost.
 */
export const SHORTS_CAPTIONS: CaptionRules = { maxLineChars: 22, maxLines: 2, maxCueSeconds: 2.5 };

// What each cue costs, so a split into many tiny cues loses to one that breaks only where
// speech does; and what a second line costs, so one punchy line wins when it fits.
const CUE_COST = 0.35;
const SECOND_LINE_COST = 0.45;
/** A pause this long between words always ends a cue. */
const SILENCE_BREAK_SECONDS = 1.2;
/** A cue stays up this long after its last word ends, unless the next cue comes first. */
const HOLD_SECONDS = 0.3;
const MIN_CUE_SECONDS = 0.5;

export interface CaptionCue {
  readonly startFrame: number;
  /** Exclusive. */
  readonly endFrame: number;
  readonly lines: ReadonlyArray<string>;
  /** The words the cue holds, as indexes into the words it was made from. */
  readonly fromWord: number;
  readonly toWord: number;
}

const lineOf = (words: ReadonlyArray<CaptionWord>, from: number, to: number) =>
  words
    .slice(from, to + 1)
    .map((word) => word.text)
    .join(" ");

/**
 * Splits the words into cues: the split whose breaks fall at the most natural gaps, with no
 * cue across a picture cut or a long pause, no line over `maxLineChars` (save a lone long
 * word) and no cue longer than `maxCueSeconds`.
 */
export const breakCaptions = (
  words: ReadonlyArray<CaptionWord>,
  cuts: ReadonlyArray<number>,
  rate: number,
  rules: CaptionRules = SHORTS_CAPTIONS,
): Array<CaptionCue> => {
  const count = words.length;
  if (count === 0) return [];
  const gapAfter = words.map((word, index) => {
    const next = words[index + 1];
    return next === undefined ? 0 : (next.startFrame - word.endFrame) / rate;
  });
  const scores = words.map((word, index) => {
    const next = words[index + 1];
    return next === undefined
      ? 1
      : breakScore(word.text, next.text, gapAfter[index]!, word.quietAfter);
  });
  // A break after word i is forced when a cut falls after its start and by the next word's.
  const forced = words.map((word, index) => {
    const next = words[index + 1];
    if (next === undefined) return true;
    return (
      gapAfter[index]! >= SILENCE_BREAK_SECONDS ||
      cuts.some((cut) => cut > word.startFrame && cut <= next.startFrame)
    );
  });

  /** The lines words `from..to` make, or null when they don't fit the rules. */
  const linesOf = (from: number, to: number): ReadonlyArray<string> | null => {
    const whole = lineOf(words, from, to);
    if (whole.length <= rules.maxLineChars || from === to) return [whole];
    if (rules.maxLines < 2) return null;
    let best: { split: number; score: number } | null = null;
    for (let split = from; split < to; split++) {
      const first = lineOf(words, from, split);
      const second = lineOf(words, split + 1, to);
      if (first.length > rules.maxLineChars || second.length > rules.maxLineChars) continue;
      // The most natural gap, and between equals the more even lines.
      const score =
        scores[split]! -
        Math.abs(first.length - second.length) / 200 -
        (LEANING.has(bare(words[split]!.text)) ? LEANING_COST : 0);
      if (best === null || score > best.score) best = { split, score };
    }
    return best === null
      ? null
      : [lineOf(words, from, best.split), lineOf(words, best.split + 1, to)];
  };

  const cost = Array.from({ length: count + 1 }, () => Number.POSITIVE_INFINITY);
  const choice = Array.from({ length: count + 1 }, () => ({
    from: 0,
    lines: [] as ReadonlyArray<string>,
  }));
  cost[0] = 0;
  for (let from = 0; from < count; from++) {
    if (!Number.isFinite(cost[from]!)) continue;
    for (let to = from; to < count; to++) {
      if (to > from && forced[to - 1]) break;
      const seconds = (words[to]!.endFrame - words[from]!.startFrame) / rate;
      if (to > from && seconds > rules.maxCueSeconds) break;
      const lines = linesOf(from, to);
      if (lines === null) {
        // A longer run only gets longer lines.
        if (to > from) break;
        continue;
      }
      const total =
        cost[from]! +
        CUE_COST +
        (lines.length > 1 ? SECOND_LINE_COST : 0) +
        (forced[to]
          ? 0
          : 1 - scores[to]! + (LEANING.has(bare(words[to]!.text)) ? LEANING_COST : 0));
      if (total < cost[to + 1]!) {
        cost[to + 1] = total;
        choice[to + 1] = { from, lines };
      }
    }
  }

  const spans: Array<{ from: number; to: number; lines: ReadonlyArray<string> }> = [];
  for (let end = count; end > 0;) {
    const { from, lines } = choice[end]!;
    spans.unshift({ from, to: end - 1, lines });
    end = from;
  }
  const hold = Math.round(HOLD_SECONDS * rate);
  const least = Math.round(MIN_CUE_SECONDS * rate);
  return spans.map((span, position) => {
    const startFrame = words[span.from]!.startFrame;
    const next = spans[position + 1];
    const nextStart = next === undefined ? Number.POSITIVE_INFINITY : words[next.from]!.startFrame;
    const cut = cuts.find((frame) => frame > startFrame) ?? Number.POSITIVE_INFINITY;
    const spoken = words[span.to]!.endFrame;
    const endFrame = Math.min(
      Math.max(spoken + hold, startFrame + least),
      nextStart,
      // A cue that ends at a cut ends there, not over the next shot.
      forced[span.to] && cut <= nextStart ? Math.max(cut, spoken) : Number.POSITIVE_INFINITY,
    );
    return {
      startFrame,
      endFrame: Math.max(endFrame, startFrame + 1),
      lines: span.lines,
      fromWord: span.from,
      toWord: span.to,
    };
  });
};

const timestamp = (frame: number, rate: number) => {
  const millis = Math.round((frame / rate) * 1000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(Math.floor(millis / 3_600_000))}:${two(Math.floor(millis / 60_000) % 60)}:${two(Math.floor(millis / 1000) % 60)},${String(millis % 1000).padStart(3, "0")}`;
};

/** The cues as SubRip, which Premiere imports as a caption track. */
export const srtText = (cues: ReadonlyArray<CaptionCue>, rate: number): string =>
  cues
    .map(
      (cue, index) =>
        `${index + 1}\n${timestamp(cue.startFrame, rate)} --> ${timestamp(cue.endFrame, rate)}\n${cue.lines.join("\n")}\n`,
    )
    .join("\n");

export interface PictureSample {
  /** The media file on screen, as the timeline names it. */
  readonly target: string;
  /** Seconds into it. */
  readonly seconds: number;
}

/**
 * The pictures under a cue at `count` evenly spread frames: the top video clip at each, as
 * a file and a time to read a frame from. Text and caption layers are left out.
 */
export const pictureSamples = (
  timeline: Timeline,
  cue: Pick<CaptionCue, "startFrame" | "endFrame">,
  count: number,
): Array<PictureSample> => {
  const layout = layoutTimeline(timeline);
  const video = layout.tracks.filter(
    (track) =>
      track.kind === "Video" &&
      !(track.metadata?.[TIMELINE_NAMESPACE] as { captions?: boolean } | undefined)?.captions,
  );
  const samples: Array<PictureSample> = [];
  for (let index = 0; index < count; index++) {
    const frame = cue.startFrame + ((index + 0.5) / count) * (cue.endFrame - cue.startFrame);
    for (const track of video) {
      const item = track.clips.find(
        (candidate) =>
          candidate.clip.enabled &&
          candidate.clip.media_references.DEFAULT_MEDIA.target_url !== "" &&
          candidate.startFrame <= frame &&
          frame < candidate.endFrame,
      );
      if (item === undefined) continue;
      samples.push({
        target: item.clip.media_references.DEFAULT_MEDIA.target_url,
        seconds: Math.max(0, sourceSecondsAt(item.clip, (frame - item.startFrame) / layout.rate)),
      });
      break;
    }
  }
  return samples;
};
