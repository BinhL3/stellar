/**
 * The footage log: per clip, what the picture pass measured, what a model saw on the contact
 * sheet, what is said, and the user's own note. The note is the user's word and always wins:
 * the model is told it is true, and the log puts it first.
 */
import { pictureClock, pictureLines, type PictureAnalysis } from "./picture.ts";
import type { TranscriptWord } from "./words.ts";

export interface DescribedSegment {
  readonly start: number;
  readonly end: number;
  readonly place: string;
  readonly subject: string;
  readonly action: string;
  readonly usable: boolean;
  readonly why: string;
}

export interface FootageDescription {
  readonly summary: string;
  readonly segments: ReadonlyArray<DescribedSegment>;
}

const MAX_SEGMENTS = 24;
const MAX_TEXT = 300;

const tidy = (text: string, limit = MAX_TEXT) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
};

/**
 * A model's description made safe to keep: segments inside the clip, in order and not
 * overlapping, text on one line and of sane length. Segments that end up empty are dropped.
 */
export const normalizeDescription = (
  output: FootageDescription,
  duration: number,
): FootageDescription => {
  const end = Math.max(0, duration);
  const clamp = (seconds: number) =>
    Number.isFinite(seconds) ? Math.min(end, Math.max(0, seconds)) : 0;
  const segments: Array<DescribedSegment> = [];
  for (const segment of output.segments
    .map((segment) => ({ ...segment, start: clamp(segment.start), end: clamp(segment.end) }))
    .toSorted((a, b) => a.start - b.start)) {
    const start = Math.max(segment.start, segments.at(-1)?.end ?? 0);
    if (segment.end - start < 0.05 || segments.length >= MAX_SEGMENTS) continue;
    segments.push({
      start: Math.round(start * 10) / 10,
      end: Math.round(segment.end * 10) / 10,
      place: tidy(segment.place),
      subject: tidy(segment.subject),
      action: tidy(segment.action),
      usable: segment.usable,
      why: segment.usable ? "" : tidy(segment.why),
    });
  }
  return { summary: tidy(output.summary, 160), segments };
};

/** The words as lines, each starting at its first word's time, broken at pauses. */
export const transcriptLines = (words: ReadonlyArray<TranscriptWord>, maxChars?: number) => {
  const lines: Array<string> = [];
  let current: Array<string> = [];
  let start = 0;
  let last = 0;
  const flush = () => {
    if (current.length > 0) lines.push(`${pictureClock(start)} ${current.join(" ")}`);
    current = [];
  };
  for (const word of words) {
    if (current.length > 0 && (word.start - last >= 1 || current.length >= 14)) flush();
    if (current.length === 0) start = word.start;
    current.push(word.w.trim());
    last = word.end;
  }
  flush();
  if (maxChars === undefined) return lines;
  const kept: Array<string> = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > maxChars) {
      kept.push(`… ${lines.length - kept.length} more lines`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return kept;
};

/** The prompt for one clip's description; the contact sheet travels as an image beside it. */
export const footageDescriptionPrompt = (input: {
  readonly fileName: string;
  readonly folder: string;
  readonly duration: number;
  readonly note: string | null;
  readonly sheetFile: string;
  readonly picture: PictureAnalysis;
  readonly words: ReadonlyArray<TranscriptWord> | null;
}): string => {
  const length = input.duration.toFixed(1);
  return [
    "You are logging raw footage for a video editor, so they can find shots by what is on screen.",
    `Clip: ${input.fileName}, ${length} seconds long${input.folder === "" ? "" : `, imported in the folder "${input.folder}" (folder names often say the day, place or camera)`}.`,
    ...(input.note === null
      ? []
      : [
          `The user's note on this clip, which is true and wins over anything else: "${input.note}". Use it, never contradict it, and describe only what it leaves out.`,
        ]),
    "",
    `Look at the image ${input.sheetFile} in your working directory: frames of this clip in time order, left to right then down, each labelled with its time (hours:minutes:seconds).`,
    "",
    "Measured from the picture (camera movement and problems by time, reliable):",
    ...pictureLines(input.picture),
    "",
    input.words === null || input.words.length === 0
      ? "Nothing is said, or there is no transcript."
      : "What is said (an automatic transcript, may be wrong):",
    ...(input.words === null ? [] : transcriptLines(input.words, 4000)),
    "",
    "Return JSON with:",
    "- summary: one line an editor would search by: where, who or what, what happens. Under 120 characters.",
    `- segments: the clip split where the place, subject or action changes, 1 to 8 of them, in order, without gaps or overlaps, from 0 to ${length} seconds. Use the frame times and the measured stretches for the edges. For each: start and end in seconds; place (where, as specific as the note, folder, signs or speech allow, otherwise plain like "sidewalk outside a fast food restaurant"); subject (who or what is in frame, and whether a face is visible and how big); action (what happens); usable (false when an editor wouldn't use it: too dark, lens covered, shaking hard, pointing at the ground, recorded by accident); why (a few words when not usable, otherwise empty).`,
    "Describe only what the frames, the transcript or the note show. Don't name people unless the note or the speech does.",
  ].join("\n");
};

export interface FootageLogClip {
  readonly clip: string;
  readonly folder: string;
  readonly duration: number;
  readonly note: string | null;
  readonly picture: PictureAnalysis | null;
  readonly contactSheet: string | null;
  readonly description: (FootageDescription & { readonly current: boolean }) | null;
  readonly describeFailed: string | null;
  readonly words: ReadonlyArray<TranscriptWord> | null;
}

/** One block for a clip; `full` adds every picture stretch and the whole transcript. */
export const footageClipText = (clip: FootageLogClip, full: boolean): string => {
  const lines = [`## ${clip.clip} · ${clip.duration.toFixed(1)}s`];
  if (clip.note !== null) lines.push(`note (user's, wins): ${clip.note}`);
  if (clip.description !== null) {
    lines.push(
      `seen${clip.description.current ? "" : " (before the note changed; redoing)"}: ${clip.description.summary}`,
    );
    for (const segment of clip.description.segments) {
      lines.push(
        `  ${pictureClock(segment.start)}-${pictureClock(segment.end)} ${[segment.place, segment.subject, segment.action].filter((part) => part !== "").join(" · ")}${segment.usable ? "" : ` · UNUSABLE: ${segment.why || "unusable"}`}`,
      );
    }
  } else if (clip.describeFailed !== null) {
    lines.push(`seen: not described (${clip.describeFailed})`);
  } else if (clip.picture !== null) {
    lines.push("seen: waiting to be described");
  }
  if (clip.picture === null) {
    lines.push("picture: not read yet");
  } else {
    const picture = pictureLines(clip.picture);
    lines.push(
      full || picture.length <= 4
        ? `picture: ${picture.join(" | ")}`
        : `picture: ${picture.slice(0, 4).join(" | ")} | +${picture.length - 4} more`,
    );
  }
  if (clip.contactSheet !== null) lines.push(`sheet: ${clip.contactSheet}`);
  if (clip.words === null) {
    lines.push("said: (no transcript)");
  } else if (clip.words.length === 0) {
    lines.push("said: nothing");
  } else {
    const said = transcriptLines(clip.words, full ? 6000 : 240);
    lines.push(
      full ? ["said:", ...said.map((line) => `  ${line}`)].join("\n") : `said: ${said.join(" / ")}`,
    );
  }
  return lines.join("\n");
};
