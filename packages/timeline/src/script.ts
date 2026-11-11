/**
 * The script as project data: its spoken lines ("beats"), ids that survive edits, and where each
 * beat is said on a timeline.
 *
 *   b4 words 120-141 frames 1830-2104: Take the rewards you'd realistically earn.
 *   b5 not on the timeline: Comment with your biggest monthly category.
 */
import type { WordsView } from "./words.ts";

/** One spoken line of a script, under the heading it sits beneath. */
export interface ScriptLine {
  readonly text: string;
  readonly section: string | null;
}

export interface BeatId {
  readonly id: string;
  readonly text: string;
}

/** Where a beat is said: its first and last word numbers and the frames they cover, or nulls. */
export interface BeatPlacement {
  readonly firstWord: number | null;
  readonly lastWord: number | null;
  readonly startFrame: number | null;
  readonly endFrame: number | null;
}

/** Lines that describe the script rather than being said, by the label they start with. */
const UNSPOKEN_LABEL =
  /^(author|date|language|duration|length|runtime|words?|word count|status|title|format|platform|b-?roll|visuals?|on-?screen|cut to|sfx|music|notes?|shot|caption|text|graphics?|tác giả|ngày|ngôn ngữ|thời lượng|hình ảnh|cảnh|ghi chú|nhạc)\s*:/i;
/** A label naming who speaks; the line after it is still said. */
const SPEAKER_LABEL = /^(vo|v\.o\.|voice-?over|narration|narrator|lời thoại|lời dẫn)\s*:\s*/i;
/** Sections that hold material around the script: none of their lines are beats. */
const UNSPOKEN_SECTION =
  /^(hook options|notes?|production notes|recording notes|sources?|references?|research|links?|metadata|shot list|b-?roll|visuals?|thumbnails?|title options|titles|description|hashtags|tags|todo|open questions|ghi chú|nguồn|tham khảo|tiêu đề|mô tả)(?![\p{L}\p{N}])/iu;
/** A language or length label under the title, such as "English · ~75 seconds". */
const LENGTH_LABEL = /^((english|vietnamese|tiếng việt)\s*([·|,(–—-]|$)|[~≈]\s*\d)/i;
const SPOKEN = /[\p{L}\p{N}]/u;

const stripInline = (line: string) =>
  line
    .replace(/<!--.*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<?https?:\/\/\S+>?/g, " ")
    // Stage directions and visual notes: [b-roll: …], [on-screen: …], [pause].
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/(\*\*|__|\*|`|~~)/g, "")
    .replace(/(^|\s)_+|_+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The spoken lines of a script written as Markdown or plain text: one beat per line of prose.
 * Headings name the section and aren't said (a lone top-level heading is the title); metadata
 * (`Author:`, `Date:`), labelled visual notes (`B-roll:`), bracketed and whole-line parenthesised
 * directions, quotes, tables, code, links and sections such as "Hook options" or "Notes" are left out.
 */
export const parseScript = (text: string): Array<ScriptLine> => {
  const lines = text.normalize("NFC").replace(/\r\n?/g, "\n").split("\n");
  const titleCount = lines.filter((line) => /^#\s/.test(line.trim())).length;
  const beats: Array<ScriptLine> = [];
  let section: string | null = null;
  // The heading level that opened an unspoken section; its subsections are unspoken too.
  let unspokenLevel: number | null = null;
  let fence = false;
  let frontMatter = lines[0]?.trim() === "---";
  for (const [number, raw] of lines.entries()) {
    const line = raw.trim();
    if (frontMatter) {
      if (number > 0 && line === "---") frontMatter = false;
      continue;
    }
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || line === "") continue;
    // A line that is all bold and isn't a sentence is a heading, as Google Docs often exports them.
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line) ?? /^(\*\*|__)([^.!?…]+?)\1:?$/.exec(line);
    if (heading !== null) {
      const name = stripInline(heading[2] ?? "");
      const level = heading[1]?.startsWith("#") ? heading[1].length : 7;
      if (level === 1 && titleCount === 1 && section === null) continue;
      if (unspokenLevel !== null && level > unspokenLevel) continue;
      section = name === "" ? null : name;
      unspokenLevel = UNSPOKEN_SECTION.test(name) ? level : null;
      continue;
    }
    if (unspokenLevel !== null) continue;
    if (/^(>|\||<!--)/.test(line) || /^([-*_=]\s*){3,}$/.test(line)) continue;
    const spoken = stripInline(
      line
        .replace(/^([-*+•]|\d+[.)])\s+/, "")
        .replace(/^\(?\d{1,2}:\d{2}(\s*[-–]\s*\d{1,2}:\d{2})?\)?\s*[-–:]?\s*/, ""),
    );
    if (UNSPOKEN_LABEL.test(spoken) || LENGTH_LABEL.test(spoken) || /^\([^)]*\)$/.test(spoken)) {
      continue;
    }
    const said = spoken.replace(SPEAKER_LABEL, "");
    if (SPOKEN.test(said)) beats.push({ text: said, section });
  }
  return beats;
};

/**
 * The words of a text as they are compared: NFC, lower case, punctuation gone. Diacritics stay,
 * so Vietnamese "má" and "ma" are different words.
 */
export const scriptTokens = (text: string): Array<string> =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/['’‘`´]/g, "")
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((token) => token !== "");

/** How alike two token lists are, 0 to 1: twice their longest common subsequence over their lengths. */
const similarity = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const token of a) {
    const row = [0];
    for (const [j, other] of b.entries()) {
      row.push(
        token === other ? (previous[j] ?? 0) + 1 : Math.max(previous[j + 1] ?? 0, row[j] ?? 0),
      );
    }
    previous = row;
  }
  return (2 * (previous[b.length] ?? 0)) / (a.length + b.length);
};

/** A reworded beat keeps its id while at least this much of it is the same words in the same order. */
const SAME_BEAT = 0.6;

/**
 * Gives each line an id, carrying ids over from the previous snapshot: first to lines whose words
 * are unchanged, then to the closest light edit of each remaining old beat. Every other line gets
 * a fresh `b<n>` from `nextId`, which only grows, so an id is never reused for a different beat.
 */
export const assignBeatIds = <Line extends { readonly text: string }>(
  previous: ReadonlyArray<BeatId>,
  lines: ReadonlyArray<Line>,
  nextId: number,
): { readonly beats: Array<Line & { readonly id: string }>; readonly nextId: number } => {
  const old = previous.map((beat) => ({ id: beat.id, tokens: scriptTokens(beat.text) }));
  const fresh = lines.map((line) => scriptTokens(line.text));
  const ids = new Array<string | undefined>(lines.length).fill(undefined);
  const taken = new Set<number>();
  for (const [index, tokens] of fresh.entries()) {
    const key = tokens.join(" ");
    const same = old.findIndex((beat, at) => !taken.has(at) && beat.tokens.join(" ") === key);
    if (same < 0) continue;
    taken.add(same);
    ids[index] = old[same]?.id;
  }
  const edits = fresh
    .flatMap((tokens, index) =>
      ids[index] === undefined
        ? old.flatMap((beat, at) =>
            taken.has(at) ? [] : [{ index, at, score: similarity(tokens, beat.tokens) }],
          )
        : [],
    )
    .filter((pair) => pair.score >= SAME_BEAT)
    .toSorted((a, b) => b.score - a.score);
  for (const { index, at } of edits) {
    if (ids[index] !== undefined || taken.has(at)) continue;
    taken.add(at);
    ids[index] = old[at]?.id;
  }
  // Ids written by hand or by an older snapshot may be ahead of the counter.
  let next = Math.max(
    nextId,
    ...previous.map((beat) => Number(/^b(\d+)$/.exec(beat.id)?.[1] ?? 0) + 1),
  );
  const beats = lines.map((line, index) => ({ ...line, id: ids[index] ?? `b${next++}` }));
  return { beats, nextId: next };
};

/**
 * A beat counts as said where its words match the transcript with at most this share of them
 * dropped, changed or interrupted by a filler. Short beats round down, so one or two words must
 * match exactly.
 */
export const MAX_DIFFERENCE = 0.35;

interface Take {
  readonly beat: number;
  /** Positions in the timeline's token list, `end` exclusive. */
  readonly start: number;
  readonly end: number;
  /** Beat words matched: what choosing this take is worth. */
  readonly matched: number;
}

/**
 * Every place a beat could have been said: the stretches of `heard` within `allowed` edits of the
 * beat (insert, drop or change a word, each costing one), best first and not overlapping.
 */
const takesOf = (
  beat: number,
  tokens: ReadonlyArray<string>,
  heard: ReadonlyArray<string>,
): Array<Take> => {
  const allowed = Math.floor(tokens.length * MAX_DIFFERENCE);
  if (tokens.length === 0) return [];
  const width = heard.length + 1;
  // cost[j]: fewest edits matching the beat's first i words to a stretch ending at j;
  // from[j]: where that stretch starts. A stretch may start anywhere, so row 0 costs nothing.
  let cost = new Int32Array(width);
  let from = Int32Array.from({ length: width }, (_, j) => j);
  for (const [i, token] of tokens.entries()) {
    const nextCost = new Int32Array(width);
    const nextFrom = new Int32Array(width);
    nextCost[0] = i + 1;
    for (let j = 1; j < width; j++) {
      const change = (cost[j - 1] ?? 0) + (heard[j - 1] === token ? 0 : 1);
      const drop = (cost[j] ?? 0) + 1;
      const extra = (nextCost[j - 1] ?? 0) + 1;
      if (change <= drop && change <= extra) {
        nextCost[j] = change;
        nextFrom[j] = from[j - 1] ?? 0;
      } else if (drop <= extra) {
        nextCost[j] = drop;
        nextFrom[j] = from[j] ?? 0;
      } else {
        nextCost[j] = extra;
        nextFrom[j] = nextFrom[j - 1] ?? 0;
      }
    }
    cost = nextCost;
    from = nextFrom;
  }
  const found: Array<Take & { readonly edits: number }> = [];
  for (let end = 1; end < width; end++) {
    const edits = cost[end] ?? 0;
    const start = from[end] ?? 0;
    if (edits <= allowed && start < end) {
      found.push({ beat, start, end, edits, matched: tokens.length - edits });
    }
  }
  const takes: Array<Take> = [];
  for (const take of found.toSorted((a, b) => a.edits - b.edits || a.end - b.end)) {
    if (takes.every((kept) => take.end <= kept.start || take.start >= kept.end)) takes.push(take);
  }
  return takes;
};

/**
 * Places each beat where it is said. A beat can match more than once (a retake left in the cut);
 * one take per beat is chosen so beats run in script order and the most script words match. A beat
 * with no take in order is skipped, not forced; of equal takes the later wins, as the keeper.
 */
export const alignBeats = <Beat extends { readonly text: string }>(
  beats: ReadonlyArray<Beat>,
  words: WordsView,
): Array<Beat & BeatPlacement> => {
  const all = words.clips.flatMap((clip) => clip.words ?? []);
  // A transcript word such as "well-known" is two script words; both point back at it.
  const heard: Array<string> = [];
  const wordAt: Array<number> = [];
  for (const [position, word] of all.entries()) {
    for (const token of scriptTokens(word.word)) {
      heard.push(token);
      wordAt.push(position);
    }
  }
  const takes = beats
    .flatMap((beat, index) => takesOf(index, scriptTokens(beat.text), heard))
    .toSorted((a, b) => a.beat - b.beat || a.start - b.start);

  // best[t]: the most words matched by an in-order chain of takes ending with take t.
  const best = takes.map((take) => take.matched);
  const before = takes.map(() => -1);
  for (const [t, take] of takes.entries()) {
    for (let p = 0; p < t; p++) {
      const earlier = takes[p];
      if (earlier === undefined || earlier.beat >= take.beat || earlier.end > take.start) continue;
      const total = (best[p] ?? 0) + take.matched;
      if (
        total > (best[t] ?? 0) ||
        (total === best[t] && before[t] !== -1 && p > (before[t] ?? 0))
      ) {
        best[t] = total;
        before[t] = p;
      }
    }
  }
  let last = -1;
  for (const [t, total] of best.entries()) {
    if (last === -1 || total >= (best[last] ?? 0)) last = t;
  }
  const chosen = new Map<number, Take>();
  for (let t = last; t !== -1; t = before[t] ?? -1) {
    const take = takes[t];
    if (take !== undefined) chosen.set(take.beat, take);
  }
  // A line the edit moved out of script order still gets its best take that overlaps nothing chosen.
  for (const take of takes.toSorted((a, b) => b.matched - a.matched || a.start - b.start)) {
    if (chosen.has(take.beat)) continue;
    const free = [...chosen.values()].every(
      (kept) => take.end <= kept.start || take.start >= kept.end,
    );
    if (free) chosen.set(take.beat, take);
  }

  return beats.map((beat, index) => {
    const take = chosen.get(index);
    const first = take === undefined ? undefined : wordAt[take.start];
    const lastWord = take === undefined ? undefined : wordAt[take.end - 1];
    if (first === undefined || lastWord === undefined) {
      return { ...beat, firstWord: null, lastWord: null, startFrame: null, endFrame: null };
    }
    const said = all.slice(first, lastWord + 1);
    return {
      ...beat,
      firstWord: first + 1,
      lastWord: lastWord + 1,
      startFrame: Math.min(...said.map((word) => word.startFrame)),
      endFrame: Math.max(...said.map((word) => word.endFrame)),
    };
  });
};

/**
 * The beats as an agent reads them: one line each, with word numbers and frames when said, under
 * a `## section` line wherever the section changes.
 */
export const beatsText = (
  beats: ReadonlyArray<BeatId & BeatPlacement & { readonly section?: string | null }>,
): string => {
  const lines: Array<string> = [];
  let section: string | null = null;
  for (const beat of beats) {
    const under = beat.section ?? null;
    if (under !== section && under !== null) lines.push(`## ${under}`);
    section = under;
    lines.push(
      beat.firstWord === null
        ? `${beat.id} not on the timeline: ${beat.text}`
        : `${beat.id} words ${beat.firstWord}-${beat.lastWord} frames ${beat.startFrame}-${beat.endFrame}: ${beat.text}`,
    );
  }
  return lines.join("\n");
};
