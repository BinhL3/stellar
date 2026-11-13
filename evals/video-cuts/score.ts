/**
 * Scores a cut by code, in seconds of each source file so two cuts of the same footage compare.
 * The metrics (removed words against a reference, edges inside words, pauses at joins) are adapted
 * from Forward-Future/scarlet's evals (MIT).
 */
import { layoutTimeline } from "../../packages/timeline/src/layout.ts";
import type { Timeline } from "../../packages/timeline/src/otio.ts";
import { mediaSpanSeconds } from "../../packages/timeline/src/speed.ts";
import { timelineWords, type TranscriptWord } from "../../packages/timeline/src/words.ts";

export type Transcripts = ReadonlyMap<string, ReadonlyArray<TranscriptWord>>;

/** One transcript word as a timeline plays it. `id` is the same in every cut of the footage. */
export interface HeardWord {
  readonly id: string;
  readonly media: string;
  /** Position in the media's transcript. */
  readonly at: number;
  readonly word: TranscriptWord;
  readonly startFrame: number;
}

/**
 * The user's verdicts on cuts, in word numbers of the starting timeline as `video_timeline_words`
 * counts them: `kept` and `added` words should be gone, `undone` words should play.
 */
export interface Decision {
  readonly fromWord: number;
  readonly toWord: number;
  readonly decision: "kept" | "undone" | "added";
}

export type Reference =
  | { readonly kind: "timeline"; readonly timeline: Timeline }
  | {
      readonly kind: "decisions";
      readonly decisions: ReadonlyArray<Decision>;
      /** True when the decisions name every cut the user wants: unnamed words should play. */
      readonly complete?: boolean;
    };

export interface RunLog {
  readonly startedAt?: string | undefined;
  readonly calls: ReadonlyArray<{ readonly tool: string; readonly at?: string | undefined }>;
}

export const REMOVED_KINDS = ["retake", "filler", "speech", "pause", "untranscribed"] as const;
export type RemovedKind = (typeof REMOVED_KINDS)[number];

/** Hesitation sounds in the languages Stellar transcribes. A case can name its own. */
export const DEFAULT_FILLERS = ["um", "uh", "uhm", "er", "erm", "hmm", "ờ", "ừm", "à", "ơ"];

/** Seconds under which a join's pause falls, per bucket; the last bucket is everything longer. */
export const PAUSE_BUCKETS = [0.1, 0.25, 0.5, 1] as const;

const RETAKE_RUN = 3;

interface Interval {
  readonly start: number;
  readonly end: number;
}

const normalize = (word: string) =>
  word
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}']/gu, "");

/**
 * The words a timeline plays, in order. Stellar's own placement decides which words a clip holds,
 * so a word counts as kept here exactly when `video_timeline_words` would list it.
 */
export const heardWords = (timeline: Timeline, transcripts: Transcripts): Array<HeardWord> => {
  const tagged = new Map(
    [...transcripts].map(([media, words]) => [
      media,
      words.map((word, at) => ({ ...word, w: JSON.stringify([media, at]) })),
    ]),
  );
  return timelineWords(timeline, tagged).clips.flatMap((clip) =>
    (clip.words ?? []).flatMap((placed) => {
      const [media, at] = JSON.parse(placed.word) as [string, number];
      const word = transcripts.get(media)?.[at];
      return word === undefined
        ? []
        : [{ id: placed.word, media, at, word, startFrame: placed.startFrame }];
    }),
  );
};

const merge = (intervals: ReadonlyArray<Interval>): Array<Interval> => {
  const merged: Array<Interval> = [];
  for (const next of intervals.toSorted((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    // Pieces of one clip touch to within the three decimals an edit rounds source times to.
    if (last !== undefined && next.start <= last.end + 0.002) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, next.end) };
    } else {
      merged.push(next);
    }
  }
  return merged;
};

/** The seconds of each media file a timeline's enabled audio clips play. */
export const keptSource = (timeline: Timeline): Map<string, Array<Interval>> => {
  const spans = new Map<string, Array<Interval>>();
  for (const track of layoutTimeline(timeline).tracks) {
    if (track.kind !== "Audio") continue;
    for (const { clip } of track.clips) {
      const media = clip.media_references.DEFAULT_MEDIA.target_url;
      if (!clip.enabled || media === "") continue;
      spans.set(media, [...(spans.get(media) ?? []), mediaSpanSeconds(clip)]);
    }
  }
  return new Map([...spans].map(([media, intervals]) => [media, merge(intervals)]));
};

const subtract = (from: ReadonlyArray<Interval>, cut: ReadonlyArray<Interval>) => {
  let rest = [...from];
  for (const hole of cut) {
    rest = rest.flatMap((piece) =>
      hole.end <= piece.start || hole.start >= piece.end
        ? [piece]
        : [
            { start: piece.start, end: Math.min(piece.end, hole.start) },
            { start: Math.max(piece.start, hole.end), end: piece.end },
          ].filter((part) => part.end - part.start > 0.002),
    );
  }
  return rest;
};

const overlap = (a: Interval, b: Interval) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

const quantile = (sorted: ReadonlyArray<number>, q: number) =>
  sorted.length === 0
    ? null
    : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null);

const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length === 0) return null;
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const round = (value: number) => Math.round(value * 1000) / 1000;
const rounded = (value: number | null) => (value === null ? null : round(value));

interface Join {
  /** The two words either side of the join, so the same join can be found in another cut. */
  readonly key: string;
  readonly pause: number;
}

/**
 * The joins a cut made: neighbouring words that were not neighbours in `start`, or whose pause it
 * changed. A pause is the time from one word's end to the next word's start, in whole frames.
 */
export const joinsOf = (
  start: ReadonlyArray<HeardWord>,
  cut: ReadonlyArray<HeardWord>,
  rate: number,
): Array<Join> => {
  const pauseAfter = (words: ReadonlyArray<HeardWord>, index: number) => {
    const word = words[index];
    const next = words[index + 1];
    if (word === undefined || next === undefined) return null;
    const pause = (next.startFrame - word.startFrame) / rate - (word.word.end - word.word.start);
    return { key: `${word.id}>${next.id}`, pause: Math.max(0, pause) };
  };
  const before = new Map(
    start.flatMap((_, index) => {
      const gap = pauseAfter(start, index);
      return gap === null ? [] : [[gap.key, gap.pause] as const];
    }),
  );
  return cut.flatMap((_, index) => {
    const gap = pauseAfter(cut, index);
    if (gap === null) return [];
    const was = before.get(gap.key);
    // Word starts are rounded to frames on both timelines, so a frame of difference is no cut.
    return was !== undefined && Math.abs(was - gap.pause) <= 1 / rate + 1e-9 ? [] : [gap];
  });
};

export const pauseStats = (joins: ReadonlyArray<Join>) => {
  const sorted = joins.map((join) => join.pause).toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    median: rounded(median(sorted)),
    p90: rounded(quantile(sorted, 0.9)),
    max: rounded(sorted.at(-1) ?? null),
    /** Joins per bucket of `PAUSE_BUCKETS`, then the ones longer than the last. */
    distribution: [...PAUSE_BUCKETS, Number.POSITIVE_INFINITY].map(
      (limit, bucket) =>
        sorted.filter(
          (pause) =>
            pause < limit && pause >= (bucket === 0 ? 0 : (PAUSE_BUCKETS[bucket - 1] ?? 0)),
        ).length,
    ),
  };
};

/** The source edges a cut added, and the ones that fall inside a transcribed word. */
export const cutEdges = (
  start: Timeline,
  cut: Timeline,
  transcripts: Transcripts,
  tolerance: number,
) => {
  const before = keptSource(start);
  const edges = [...keptSource(cut)].flatMap(([media, intervals]) =>
    intervals
      .flatMap((interval) => [interval.start, interval.end])
      // An edge the starting timeline already had is not this cut's.
      .filter((at) =>
        (before.get(media) ?? []).some(
          (piece) => at > piece.start + 0.002 && at < piece.end - 0.002,
        ),
      )
      .map((at) => ({ media, at })),
  );
  const inside = edges.flatMap(({ media, at }) => {
    const word = (transcripts.get(media) ?? []).findIndex(
      (candidate) => at > candidate.start + tolerance && at < candidate.end - tolerance,
    );
    return word < 0 ? [] : [{ media, at: round(at), word }];
  });
  return { count: edges.length, insideWord: inside.length, inside };
};

const removedByKind = (input: {
  readonly start: Timeline;
  readonly cut: Timeline;
  readonly transcripts: Transcripts;
  readonly removed: ReadonlyArray<HeardWord>;
  readonly kept: ReadonlyArray<HeardWord>;
  readonly fillers: ReadonlyArray<string>;
}) => {
  const fillers = new Set(input.fillers.map(normalize));
  const runKey = (words: ReadonlyArray<HeardWord>) =>
    words.map((word) => normalize(word.word.w)).join(" ");
  const keptRuns = new Set(
    input.kept.flatMap((_, index) =>
      index + RETAKE_RUN <= input.kept.length
        ? [runKey(input.kept.slice(index, index + RETAKE_RUN))]
        : [],
    ),
  );
  // A removed run of words that the cut still says somewhere else is a retake of that line.
  const retakes = new Set<string>();
  for (const [index, word] of input.removed.entries()) {
    const run = input.removed.slice(index, index + RETAKE_RUN);
    const consecutive = run.every(
      (other, offset) => other.media === word.media && other.at === word.at + offset,
    );
    if (run.length === RETAKE_RUN && consecutive && keptRuns.has(runKey(run))) {
      for (const member of run) retakes.add(member.id);
    }
  }
  const kindOf = (word: HeardWord): RemovedKind =>
    fillers.has(normalize(word.word.w)) ? "filler" : retakes.has(word.id) ? "retake" : "speech";

  const seconds: Record<RemovedKind, number> = {
    retake: 0,
    filler: 0,
    speech: 0,
    pause: 0,
    untranscribed: 0,
  };
  const after = keptSource(input.cut);
  for (const [media, intervals] of keptSource(input.start)) {
    for (const hole of subtract(intervals, after.get(media) ?? [])) {
      const length = hole.end - hole.start;
      if (!input.transcripts.has(media)) {
        seconds.untranscribed += length;
        continue;
      }
      let spoken = 0;
      for (const word of input.removed) {
        if (word.media !== media) continue;
        const share = overlap(hole, word.word);
        seconds[kindOf(word)] += share;
        spoken += share;
      }
      // Transcript words can overlap; a pause is never negative.
      seconds.pause += Math.max(0, length - spoken);
    }
  }
  const total = REMOVED_KINDS.reduce((sum, kind) => sum + seconds[kind], 0);
  return {
    seconds: round(total),
    byKind: Object.fromEntries(REMOVED_KINDS.map((kind) => [kind, round(seconds[kind])])),
  };
};

const referenceLabels = (
  start: ReadonlyArray<HeardWord>,
  reference: Reference,
  transcripts: Transcripts,
) => {
  if (reference.kind === "timeline") {
    const plays = new Set(heardWords(reference.timeline, transcripts).map((word) => word.id));
    return new Map(start.map((word) => [word.id, !plays.has(word.id)]));
  }
  const removed = new Map<string, boolean>(
    reference.complete === true ? start.map((word) => [word.id, false]) : [],
  );
  for (const { fromWord, toWord, decision } of reference.decisions) {
    for (const word of start.slice(fromWord - 1, toWord)) {
      removed.set(word.id, decision !== "undone");
    }
  }
  return removed;
};

const ratio = (part: number, whole: number) => (whole === 0 ? null : round(part / whole));

/** Seconds from the run's start to its first `video_timeline_edit`, when the log times both. */
export const timeToFirstEdit = (log: RunLog | undefined) => {
  const first = log?.calls.find((call) => call.tool === "video_timeline_edit")?.at;
  if (log?.startedAt === undefined || first === undefined) return null;
  const seconds = (Date.parse(first) - Date.parse(log.startedAt)) / 1000;
  return Number.isFinite(seconds) ? round(seconds) : null;
};

export const scoreCut = (input: {
  /** The timeline the agent was given. */
  readonly start: Timeline;
  /** The timeline the agent left. */
  readonly result: Timeline;
  readonly transcripts: Transcripts;
  readonly reference?: Reference | undefined;
  readonly fillers?: ReadonlyArray<string> | undefined;
  readonly log?: RunLog | undefined;
}) => {
  const { start, result, transcripts, reference } = input;
  const rate = layoutTimeline(start).rate;
  // A cut made on the frame grid can sit half a frame from the transcript's time for a word.
  const tolerance = Math.max(0.02, 0.5 / rate);
  const seconds = (timeline: Timeline) => {
    const layout = layoutTimeline(timeline);
    return round(layout.durationFrames / layout.rate);
  };
  const before = heardWords(start, transcripts);
  const after = heardWords(result, transcripts);
  const plays = new Set(after.map((word) => word.id));
  const removed = before.filter((word) => !plays.has(word.id));
  const joins = joinsOf(before, after, rate);

  const labels = reference === undefined ? null : referenceLabels(before, reference, transcripts);
  const labelled = before.filter((word) => labels?.has(word.id) === true);
  const wanted = labelled.filter((word) => labels?.get(word.id) === true);
  const cutLabelled = labelled.filter((word) => !plays.has(word.id));
  const hits = cutLabelled.filter((word) => labels?.get(word.id) === true).length;
  const precision = ratio(hits, cutLabelled.length);
  const recall = ratio(hits, wanted.length);

  const referenceTimeline = reference?.kind === "timeline" ? reference.timeline : null;
  const referenceJoins =
    referenceTimeline === null
      ? null
      : joinsOf(before, heardWords(referenceTimeline, transcripts), rate);
  const shared =
    referenceJoins === null
      ? []
      : joins.flatMap((join) => {
          const theirs = referenceJoins.find((other) => other.key === join.key);
          return theirs === undefined ? [] : [join.pause - theirs.pause];
        });

  return {
    seconds: {
      start: seconds(start),
      result: seconds(result),
      reference: referenceTimeline === null ? null : seconds(referenceTimeline),
    },
    removed: {
      words: removed.length,
      ...removedByKind({
        start,
        cut: result,
        transcripts,
        removed,
        kept: after,
        fillers: input.fillers ?? DEFAULT_FILLERS,
      }),
    },
    /** Removed words against the reference; null without one. Unlabelled words are left out. */
    words:
      labels === null
        ? null
        : {
            labelled: labelled.length,
            removed: cutLabelled.length,
            referenceRemoved: wanted.length,
            agreed: labelled.filter((word) => labels.get(word.id) === !plays.has(word.id)).length,
            precision,
            recall,
            f1:
              precision === null || recall === null || precision + recall === 0
                ? null
                : round((2 * precision * recall) / (precision + recall)),
          },
    edges: cutEdges(start, result, transcripts, tolerance),
    joins: pauseStats(joins),
    /** The same measures of a reference timeline, and the joins both cuts made. */
    reference:
      referenceTimeline === null || referenceJoins === null
        ? null
        : {
            edges: cutEdges(start, referenceTimeline, transcripts, tolerance),
            joins: pauseStats(referenceJoins),
            sharedJoins: {
              count: shared.length,
              /** This cut's pause minus the reference's, at the same join. */
              medianDifference: rounded(median(shared)),
              medianAbsoluteDifference: rounded(median(shared.map(Math.abs))),
            },
          },
    timeToFirstEditSeconds: timeToFirstEdit(input.log),
  };
};

export type CutScore = ReturnType<typeof scoreCut>;
