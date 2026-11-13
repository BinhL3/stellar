/**
 * Where a cut lands in the sound: edges named by words go onto the quiet between them, edges
 * that clip a sounding word are refused, and every join reads back as heard. Rules adapted
 * from Scarlet (Forward-Future, MIT): dialogue-join.ts, dialogue-leftovers.ts, AI-AGENTS.md.
 */
import {
  type AudioLevels,
  edgeLevel,
  gapSound,
  quietCeiling,
  quietSpan,
  soundFloor,
} from "./levels.ts";
import {
  type ClipSource,
  type ClipWords,
  frameOfSourceSeconds,
  gapToken,
  sourceSecondsOfFrame,
  type TimelineWord,
  type TranscriptWord,
  WORD_LEAD_SECONDS,
  wordRange,
  type WordsView,
} from "./words.ts";

type Levels = ReadonlyMap<string, AudioLevels>;
type Transcripts = ReadonlyMap<string, ReadonlyArray<TranscriptWord>>;
type Sourced = ClipWords & { readonly source: ClipSource };

/** One end of a clip, by the source second it plays there. `end` is a clip's last frame. */
export interface SourceEdge {
  readonly target: string;
  readonly side: "start" | "end";
  readonly seconds: number;
}

export interface PlacedCut {
  /** Timeline frames to remove, as `removeRange` takes them. */
  readonly start: number;
  readonly end: number;
  /** What was measured and what moved, for the agent. */
  readonly note: string;
  /** The clip edges this cut makes, which Stellar placed and so does not refuse. */
  readonly edges: ReadonlyArray<SourceEdge>;
}

/** A cut that removes nothing, and why, for the agent. */
export interface NothingToCut {
  readonly nothing: string;
}

/** A word's sound is trusted to be inside its timing only this far from each end. */
const WORD_MARGIN_SECONDS = 0.02;
/** An edge may reach this far into the word that stays, and this far into the one that goes. */
const KEPT_SLACK_SECONDS = 0.05;
const REMOVED_SLACK_SECONDS = WORD_LEAD_SECONDS;
/** Frames this close to the lowest level between two words are as good as it. */
const NEAR_LOWEST_DB = 3;
/** A pause trimmed by word keeps this much unless told otherwise. */
export const PAUSE_LEAVE_SECONDS = 0.25;
/** Of what a trimmed pause keeps, the share that follows the word before it: its decay. */
const AIR_AFTER_SHARE = 0.6;
/** A pause the cut still plays is listed from this length. */
export const LONG_PAUSE_SECONDS = 0.75;
/** A second saying counts as a repeat when it starts within this of the first, as heard. */
const REPEAT_WITHIN_SECONDS = 3;
const NEAREST_QUIET_REACH_SECONDS = 0.75;
/** A piece of a clip this short beside a word cut is a flash of picture, not something kept. */
const SLIVER_SECONDS = 0.1;
/** Joins and pauses in one page of the audit. */
export const AUDIT_PAGE = 60;

const seconds = (value: number) => `${value.toFixed(2)}s`;
const moved = (frames: number, rate: number) =>
  `${seconds(Math.abs(frames) / rate)} ${frames > 0 ? "later" : "earlier"}`;

const locate = (view: WordsView, index: number) => {
  for (const clip of view.clips) {
    const first = clip.words?.[0];
    if (clip.words === null || first === undefined || clip.source === null) continue;
    const position = index - first.index;
    const word = clip.words[position];
    if (word !== undefined) return { clip: clip as Sourced, words: clip.words, position, word };
  }
  return null;
};

/**
 * The frame for an edge first put at `original`: of the whole frames whose source second lies
 * in `window`, the nearest to `original` that is as quiet as the window gets. An edge already
 * on quiet stays, so the pacing the word timings gave is kept.
 */
const placeEdge = (
  clip: Sourced,
  rate: number,
  levels: AudioLevels | undefined,
  original: number,
  window: { readonly from: number; readonly to: number },
  toward: 1 | -1,
): { readonly frame: number; readonly db: number | undefined } => {
  if (levels === undefined) return { frame: original, db: undefined };
  const at = (frame: number) => edgeLevel(levels, sourceSecondsOfFrame(clip.source, frame, rate));
  const low = Math.max(
    Math.ceil(frameOfSourceSeconds(clip.source, window.from, rate) - 1e-6),
    clip.startFrame,
  );
  const high = Math.min(
    Math.floor(frameOfSourceSeconds(clip.source, window.to, rate) + 1e-6),
    clip.endFrame,
  );
  const candidates = new Set([original]);
  for (let frame = low; frame <= high; frame++) candidates.add(frame);
  const measured = [...candidates].flatMap((frame) => {
    const db = at(frame);
    return db === undefined ? [] : [{ frame, db }];
  });
  if (measured.length === 0) return { frame: original, db: at(original) };
  const lowest = Math.min(...measured.map((candidate) => candidate.db));
  const enough = Math.max(lowest + NEAR_LOWEST_DB, quietCeiling(levels));
  const [best] = measured
    .filter((candidate) => candidate.db <= enough)
    .toSorted(
      (a, b) =>
        Math.abs(a.frame - original) - Math.abs(b.frame - original) || (b.frame - a.frame) * toward,
    );
  return best ?? { frame: original, db: at(original) };
};

const edgeNote = (
  name: string,
  placed: { readonly frame: number; readonly db: number | undefined },
  original: number,
  rate: number,
  levels: AudioLevels | undefined,
  between: string,
) => {
  if (placed.db === undefined || levels === undefined) return `${name} not measured`;
  const where =
    placed.frame === original
      ? `${name} at ${placed.db} dBFS`
      : `${name} moved ${moved(placed.frame - original, rate)} to ${placed.db} dBFS`;
  return placed.db >= soundFloor(levels)
    ? `${where} (no quiet ${between}: speech sits at ${levels.speech} dBFS, so this join may be heard)`
    : where;
};

/**
 * The frames that remove words `fromWord` to `toWord`, each edge moved onto the quietest point
 * between the word that goes and its neighbour that stays, or why there are none. Without
 * levels for a clip its edge stays where the word timings put it, and the note says so.
 */
export const placeWordCut = (
  view: WordsView,
  levels: Levels,
  fromWord: number,
  toWord: number,
): PlacedCut | string => {
  const range = wordRange(view, fromWord, toWord);
  if (typeof range === "string") return range;
  const head = locate(view, fromWord);
  const tail = locate(view, toWord);
  const label = fromWord === toWord ? `word ${fromWord}` : `words ${fromWord}-${toWord}`;
  // Clips out of timeline order: the range isn't these two words' own edges, so it stays.
  if (
    head === null ||
    tail === null ||
    head.word.startFrame !== range.start ||
    tail.word.endFrame !== range.end
  ) {
    return {
      ...range,
      note: `${label}: frames ${range.start}-${range.end} by word timings, not measured`,
      edges: [],
    };
  }
  const { rate } = view;
  const before = head.words[head.position - 1];
  const first = head.word;
  const startLevels = levels.get(head.clip.source.target);
  const start = placeEdge(
    head.clip,
    rate,
    startLevels,
    range.start,
    {
      from:
        before === undefined
          ? sourceSecondsOfFrame(head.clip.source, head.clip.startFrame, rate)
          : Math.min(before.end, first.start) - KEPT_SLACK_SECONDS,
      to: first.start + Math.min(REMOVED_SLACK_SECONDS, Math.max(0, first.end - first.start) / 2),
    },
    1,
  );
  const after = tail.words[tail.position + 1];
  const last = tail.word;
  const endLevels = levels.get(tail.clip.source.target);
  const lastEnd = after === undefined ? last.end : Math.min(last.end, after.start);
  const end = placeEdge(
    tail.clip,
    rate,
    endLevels,
    range.end,
    {
      from: lastEnd - Math.min(REMOVED_SLACK_SECONDS, Math.max(0, lastEnd - last.start) / 2),
      to:
        after === undefined
          ? sourceSecondsOfFrame(tail.clip.source, tail.clip.endFrame, rate)
          : after.start + KEPT_SLACK_SECONDS,
    },
    -1,
  );
  if (end.frame <= start.frame) {
    return {
      ...range,
      note: `${label}: frames ${range.start}-${range.end} by word timings (no room to move the edges onto quiet)`,
      edges: [],
    };
  }
  // A few frames of a clip left before its first word or after its last would flash by on
  // screen: the cut takes them with the word.
  const sliver = Math.round(SLIVER_SECONDS * rate);
  const fromClipStart = before === undefined && start.frame - head.clip.startFrame <= sliver;
  const toClipEnd = after === undefined && tail.clip.endFrame - end.frame <= sliver;
  const startFrame = fromClipStart ? head.clip.startFrame : start.frame;
  const endFrame = toClipEnd ? tail.clip.endFrame : end.frame;
  const notes = [
    fromClipStart
      ? "start at its clip's start"
      : edgeNote(
          "start",
          start,
          range.start,
          rate,
          startLevels,
          before === undefined
            ? `before "${first.word}"`
            : `between "${before.word}" and "${first.word}"`,
        ),
    toClipEnd
      ? "end at its clip's end"
      : edgeNote(
          "end",
          end,
          range.end,
          rate,
          endLevels,
          after === undefined
            ? `after "${last.word}"`
            : `between "${last.word}" and "${after.word}"`,
        ),
  ];
  return {
    start: startFrame,
    end: endFrame,
    note: `${label}: frames ${startFrame}-${endFrame}, ${notes.join(", ")}`,
    edges: [
      {
        target: head.clip.source.target,
        side: "end",
        seconds: sourceSecondsOfFrame(head.clip.source, startFrame, rate),
      },
      {
        target: tail.clip.source.target,
        side: "start",
        seconds: sourceSecondsOfFrame(tail.clip.source, endFrame, rate),
      },
    ],
  };
};

/**
 * The frames that trim the pause after word `afterWord` down to `leave` seconds, taken from
 * the measured quiet between it and the next word; a note alone when there is nothing to
 * trim; or why the pause can't be trimmed by word.
 */
export const placePauseCut = (
  view: WordsView,
  levels: Levels,
  afterWord: number,
  leave: number = PAUSE_LEAVE_SECONDS,
): PlacedCut | NothingToCut | string => {
  if (!(leave >= 0)) return `leave ${leave} is not a length in seconds`;
  const found = Number.isInteger(afterWord) ? locate(view, afterWord) : null;
  if (found === null) return `no word ${afterWord} (the timeline has ${view.count} words)`;
  const { clip, word } = found;
  const next = found.words[found.position + 1];
  const name = `the pause after ${afterWord}:${word.word}`;
  if (next === undefined) {
    return `word ${afterWord} is the last in its clip, so ${name} is a join: trim the clips either side of it (the joins action lists them)`;
  }
  const measured = levels.get(clip.source.target);
  if (measured === undefined) {
    return `${name} can't be measured: ${clip.name} has no audio levels. Use removeRange`;
  }
  const { rate } = view;
  const frame = (at: number) => frameOfSourceSeconds(clip.source, at, rate);
  const gap = { start: word.end, end: next.start };
  const sound = gap.end > gap.start ? gapSound(measured, gap) : undefined;
  if (sound !== undefined && sound.runs.length > 0) {
    const runs = sound.runs.map(
      (run) => `${Math.round(frame(run.start))}-${Math.round(frame(run.end))}`,
    );
    return `${name} holds ${seconds(sound.seconds / clip.source.scalar)} of sound at speaking level that no word explains (frames ${runs.join(", ")}), so it is not only a pause. Decide what that sound is, then cut with removeRange or leave it`;
  }
  const quiet = gap.end > gap.start ? quietSpan(measured, gap) : null;
  if (quiet === null) {
    return { nothing: `${name}: no measured quiet between the words, nothing removed` };
  }
  const heard = (quiet.end - quiet.start) / clip.source.scalar;
  // Of what stays, more follows the word than leads the next: a word's decay outlasts its onset.
  const start = Math.ceil(frame(quiet.start + leave * AIR_AFTER_SHARE * clip.source.scalar) - 1e-6);
  const end = Math.floor(
    frame(quiet.end - leave * (1 - AIR_AFTER_SHARE) * clip.source.scalar) + 1e-6,
  );
  if (end <= start) {
    return {
      nothing: `${name}: ${seconds(heard)} of quiet, already about ${seconds(leave)}; nothing removed`,
    };
  }
  return {
    start,
    end,
    note: `${name}: ${seconds(heard)} of quiet (at most ${quiet.db} dBFS), removed frames ${start}-${end}, ${seconds(heard - (end - start) / rate)} left`,
    edges: [
      {
        target: clip.source.target,
        side: "end",
        seconds: sourceSecondsOfFrame(clip.source, start, rate),
      },
      {
        target: clip.source.target,
        side: "start",
        seconds: sourceSecondsOfFrame(clip.source, end, rate),
      },
    ],
  };
};

interface Join {
  readonly track: string;
  readonly frame: number;
  readonly out: Sourced | null;
  readonly in: Sourced | null;
  /** Empty frames between the two clips. */
  readonly gapFrames: number;
}

const endSeconds = (clip: Sourced, rate: number) =>
  sourceSecondsOfFrame(clip.source, clip.endFrame, rate);

/**
 * Every place a track's sound changes: between clips, and at a clip beside nothing. Two pieces
 * of one clip that still play straight through, as a split leaves them, are not a join.
 */
const joinsOf = (view: WordsView): Array<Join> => {
  const joins: Array<Join> = [];
  const tracks = new Map<string, Array<ClipWords>>();
  for (const clip of view.clips) tracks.set(clip.track, [...(tracks.get(clip.track) ?? []), clip]);
  const sourced = (clip: ClipWords | undefined) =>
    clip === undefined || clip.source === null ? null : (clip as Sourced);
  for (const [track, clips] of tracks) {
    const ordered = clips.toSorted((a, b) => a.startFrame - b.startFrame);
    for (let i = 0; i <= ordered.length; i++) {
      const out = sourced(ordered[i - 1]);
      const into = sourced(ordered[i]);
      if (out === null && into === null) continue;
      const frame = into?.startFrame ?? out?.endFrame ?? 0;
      const gapFrames = out === null || into === null ? 0 : into.startFrame - out.endFrame;
      const straightThrough =
        out !== null &&
        into !== null &&
        gapFrames === 0 &&
        out.source.target === into.source.target &&
        out.source.scalar === into.source.scalar &&
        Math.abs(endSeconds(out, view.rate) - into.source.startSeconds) <
          (0.5 / view.rate) * out.source.scalar + 1e-3;
      if (!straightThrough) joins.push({ track, frame, out, in: into, gapFrames });
    }
  }
  return joins;
};

/** The transcript word a source second falls inside, clear of its ends. */
const wordAround = (words: ReadonlyArray<TranscriptWord> | undefined, at: number) =>
  words?.find(
    (word) => word.start + WORD_MARGIN_SECONDS < at && at < word.end - WORD_MARGIN_SECONDS,
  );

export interface ClippedEdge extends SourceEdge {
  readonly track: string;
  readonly clipId: string;
  readonly clipName: string;
  /** The word the edge cuts, and its number on the timeline as it was, when it had one. */
  readonly word: string;
  readonly wordIndex: number | null;
  readonly db: number;
  readonly speech: number;
  readonly roomTone: number;
  /** The nearest frame under speaking level, as frames from the edge. */
  readonly quiet: { readonly frames: number; readonly db: number } | null;
}

const sameEdge = (a: SourceEdge, b: SourceEdge) =>
  a.target === b.target && a.side === b.side && Math.abs(a.seconds - b.seconds) < 0.004;

const heardEdges = (view: WordsView) =>
  joinsOf(view).flatMap((join) => [
    ...(join.out === null
      ? []
      : [
          {
            clip: join.out,
            target: join.out.source.target,
            side: "end" as const,
            seconds: endSeconds(join.out, view.rate),
          },
        ]),
    ...(join.in === null
      ? []
      : [
          {
            clip: join.in,
            target: join.in.source.target,
            side: "start" as const,
            seconds: join.in.source.startSeconds,
          },
        ]),
  ]);

/**
 * The clip edges `after` has and `before` did not that cut a word while it sounds. Edges in
 * `placed` were put on measured quiet by a word cut and pass. A clip with no transcript or no
 * levels can't be judged and passes too.
 */
export const clippedEdges = (
  before: WordsView,
  after: WordsView,
  transcripts: Transcripts,
  levels: Levels,
  placed: ReadonlyArray<SourceEdge>,
): Array<ClippedEdge> => {
  const known = [...heardEdges(before), ...placed];
  const numbered = new Map<string, number>();
  for (const clip of before.clips) {
    for (const word of clip.words ?? []) {
      numbered.set(`${clip.source?.target}\n${word.start}`, word.index);
    }
  }
  const found: Array<ClippedEdge> = [];
  for (const edge of heardEdges(after)) {
    const measured = levels.get(edge.target);
    const words = transcripts.get(edge.target);
    if (measured === undefined || words === undefined) continue;
    if (known.some((other) => sameEdge(other, edge))) continue;
    if (found.some((other) => sameEdge(other, edge))) continue;
    const word = wordAround(words, edge.seconds);
    const db = edgeLevel(measured, edge.seconds);
    const floor = soundFloor(measured);
    if (word === undefined || db === undefined || db < floor) continue;
    const step = edge.clip.source.scalar / after.rate;
    let quiet: ClippedEdge["quiet"] = null;
    for (let k = 1; k <= Math.round(NEAREST_QUIET_REACH_SECONDS * after.rate) && !quiet; k++) {
      for (const frames of [k, -k]) {
        const at = edge.seconds + frames * step;
        const there = edgeLevel(measured, at);
        // The level decides: a word's timing often runs past its sound.
        if (there === undefined || there >= floor) continue;
        if (quiet === null || there < quiet.db) quiet = { frames, db: there };
      }
    }
    found.push({
      target: edge.target,
      side: edge.side,
      seconds: edge.seconds,
      track: edge.clip.track,
      clipId: edge.clip.clipId,
      clipName: edge.clip.name,
      word: word.w,
      wordIndex: numbered.get(`${edge.target}\n${word.start}`) ?? null,
      db,
      speech: measured.speech,
      roomTone: measured.roomTone,
      quiet,
    });
  }
  return found;
};

/** Why an edit is refused for `edge`, and what to do instead. */
export const clippedEdgeReason = (edge: ClippedEdge, rate: number): string => {
  const word = edge.wordIndex === null ? `"${edge.word}"` : `word ${edge.wordIndex} "${edge.word}"`;
  const quiet =
    edge.quiet === null
      ? `No quiet point within ${NEAREST_QUIET_REACH_SECONDS}s of it`
      : `The nearest quiet is ${Math.abs(edge.quiet.frames)} frame${Math.abs(edge.quiet.frames) === 1 ? "" : "s"} (${moved(edge.quiet.frames, rate)}) at ${edge.quiet.db} dBFS`;
  return `it would ${edge.side === "start" ? "start" : "end"} #${edge.clipId} (${edge.clipName}, ${edge.track}) inside ${word} while it sounds: ${edge.db} dBFS at the edge, where this recording's speech sits at ${edge.speech} and its room tone at ${edge.roomTone}. ${quiet}. Cut by word instead (removeWords, or trimPause with afterWord), which puts the edge on measured quiet, or move the edge to the quiet point`;
};

const normalized = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
const numberedWords = (words: ReadonlyArray<TimelineWord>) =>
  words.map((word) => `${word.index}:${word.word}`).join(" ");

/** The words said twice in a row across a join: the end of one side repeated by the start of the other. */
const repeatAcross = (out: ReadonlyArray<TimelineWord>, into: ReadonlyArray<TimelineWord>) => {
  for (let n = Math.min(4, out.length, into.length); n > 0; n--) {
    const said = out.slice(-n);
    const again = into.slice(0, n);
    // "…it. It…" ends one sentence and starts the next.
    if (n === 1 && /[.?!]["'”’)\]]*$/u.test(said[0]?.word.trim() ?? "")) continue;
    if (
      said.every((word, i) => {
        const token = normalized(word.word);
        return token !== "" && token === normalized(again[i]?.word ?? "");
      })
    ) {
      return again.map((word) => word.word).join(" ");
    }
  }
  return null;
};

export interface JoinAudit {
  readonly joins: number;
  readonly flagged: number;
  readonly pauses: number;
  /** Joins between two clips that have no transcript, which can't be read. */
  readonly unread: number;
  /** One line per join or long pause, in timeline order. */
  readonly lines: ReadonlyArray<string>;
}

/**
 * Every join on a timeline as it is heard: the words either side, the level at each edge,
 * a word cut while it sounds, words said twice across the join, and the pause it plays; then
 * the pauses inside clips of `pauseOver` seconds or more.
 */
export const auditJoins = (
  view: WordsView,
  transcripts: Transcripts,
  levels: Levels,
  pauseOver: number = LONG_PAUSE_SECONDS,
): JoinAudit => {
  const { rate } = view;
  const items: Array<{ readonly frame: number; readonly line: string }> = [];
  let joins = 0;
  let flagged = 0;
  let unread = 0;
  for (const join of joinsOf(view)) {
    const { out, in: into } = join;
    // The first clip's start and the last one's end are edges, not joins.
    if (out === null || into === null) continue;
    if (out.words === null && into.words === null) {
      unread += 1;
      continue;
    }
    joins += 1;
    const flags: Array<string> = [];
    const side = (clip: Sourced, which: "start" | "end") => {
      const at = which === "end" ? endSeconds(clip, rate) : clip.source.startSeconds;
      const measured = levels.get(clip.source.target);
      const db = measured === undefined ? undefined : edgeLevel(measured, at);
      const cut =
        clip.words === null ? undefined : wordAround(transcripts.get(clip.source.target), at);
      const sounding = measured !== undefined && db !== undefined && db >= soundFloor(measured);
      if (cut !== undefined && (sounding || measured === undefined)) {
        flags.push(
          `clips "${cut.w}" at its ${which === "end" ? "end" : "start"}${measured === undefined ? " by word timings" : ""}`,
        );
      } else if (sounding) {
        flags.push(`${which === "end" ? "outgoing" : "incoming"} edge at speaking level`);
      }
      return {
        at,
        cut,
        level: clip.words === null ? "" : db === undefined ? "[unmeasured]" : `[${db} dBFS]`,
      };
    };
    const outgoing = side(out, "end");
    const incoming = side(into, "start");
    const said = out.words ?? [];
    const next = into.words ?? [];
    const repeat = repeatAcross(said, next);
    const lastSaid = said.at(-1);
    const firstNext = next[0];
    if (lastSaid !== undefined && firstNext !== undefined) {
      const pause =
        Math.max(0, outgoing.at - lastSaid.end) / out.source.scalar +
        join.gapFrames / rate +
        (incoming.cut === undefined
          ? Math.max(0, firstNext.start - incoming.at) / into.source.scalar
          : 0);
      if (repeat !== null && pause < REPEAT_WITHIN_SECONDS) flags.push(`repeats "${repeat}"`);
      if (pause >= pauseOver) flags.push(`pause ${seconds(pause)}`);
    }
    if (join.gapFrames > 0)
      flags.push(`${seconds(join.gapFrames / rate)} of nothing between the clips`);
    if (flags.length > 0) flagged += 1;
    const words = (clip: Sourced, shown: ReadonlyArray<TimelineWord>) =>
      clip.words === null
        ? `(${clip.unplaced ?? "no transcript"})`
        : numberedWords(shown) || "(no words)";
    items.push({
      frame: join.frame,
      line: `J ${join.track} @${join.frame} (${seconds(join.frame / rate)}) #${out.clipId}|#${into.clipId}: ${words(out, said.slice(-3))} ${outgoing.level} | ${incoming.level} ${words(into, next.slice(0, 3))} · ${flags.join(" · ") || "ok"}`.replace(
        / {2,}/g,
        " ",
      ),
    });
  }
  let pauses = 0;
  for (const clip of view.clips) {
    if (clip.words === null || clip.source === null) continue;
    for (const [position, word] of clip.words.entries()) {
      const previous = clip.words[position - 1];
      if (previous === undefined) continue;
      if ((word.start - previous.end) / clip.source.scalar < pauseOver) continue;
      const frame = Math.round(frameOfSourceSeconds(clip.source, previous.end, rate));
      pauses += 1;
      items.push({
        frame,
        line: `P ${clip.track} @${frame} (${seconds(frame / rate)}) after ${previous.index}:${previous.word} ${gapToken(clip, previous, word, rate, levels) ?? ""}`,
      });
    }
  }
  return {
    joins,
    flagged,
    pauses,
    unread,
    lines: items.toSorted((a, b) => a.frame - b.frame).map((item) => item.line),
  };
};

/** The audit as an agent reads it, `AUDIT_PAGE` lines at a time from line `from`. */
export const joinAuditText = (
  view: WordsView,
  audit: JoinAudit,
  options: { readonly from?: number; readonly pauseOver?: number } = {},
): string => {
  const first = Math.max(1, Math.floor(options.from ?? 1));
  const shown = audit.lines.slice(first - 1, first - 1 + AUDIT_PAGE);
  const last = first - 1 + shown.length;
  return [
    `# ${view.name} · ${audit.joins} joins, ${audit.flagged} flagged · ${audit.pauses} pauses of ${seconds(options.pauseOver ?? LONG_PAUSE_SECONDS)} or more · frames @${view.rate}`,
    "# J track @frame (time) #outClip|#inClip: last words [level at the outgoing edge] | [level at the incoming edge] first words · what is wrong, or ok",
    "# P track @frame (time) after word (pause and what sounds in it); trimPause with that afterWord trims it",
    ...shown,
    ...(audit.unread === 0
      ? []
      : [`# ${audit.unread} joins between clips with no transcript are not listed`]),
    ...(last < audit.lines.length
      ? [`# lines ${first}-${last} of ${audit.lines.length}; read on with from ${last + 1}`]
      : []),
  ].join("\n");
};
