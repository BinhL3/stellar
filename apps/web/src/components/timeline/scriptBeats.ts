import type { VideoScriptBeat } from "@t3tools/contracts";

type PlacedBeat = Pick<VideoScriptBeat, "id" | "startFrame" | "endFrame">;

/**
 * The beat being said at `frame`: the last one to start at or before it. A beat stays current
 * through the pause after its last word, for up to `graceFrames`, so the highlight doesn't blink
 * off between sentences.
 */
export const beatAtFrame = (
  beats: ReadonlyArray<PlacedBeat>,
  frame: number,
  graceFrames: number,
): string | null => {
  let current: PlacedBeat | null = null;
  for (const beat of beats) {
    if (beat.startFrame === null || beat.startFrame > frame) continue;
    if (current === null || beat.startFrame >= (current.startFrame ?? 0)) current = beat;
  }
  if (current === null) return null;
  const end = current.endFrame ?? current.startFrame ?? 0;
  return frame <= end + graceFrames ? current.id : null;
};

interface BeatSection<Beat> {
  readonly section: string | null;
  readonly beats: ReadonlyArray<Beat>;
}

/** Consecutive beats under one heading, in script order. */
export const groupBeatsBySection = <Beat extends Pick<VideoScriptBeat, "section">>(
  beats: ReadonlyArray<Beat>,
): ReadonlyArray<BeatSection<Beat>> => {
  const sections: Array<{ section: string | null; beats: Array<Beat> }> = [];
  for (const beat of beats) {
    const last = sections.at(-1);
    if (last !== undefined && last.section === beat.section) last.beats.push(beat);
    else sections.push({ section: beat.section, beats: [beat] });
  }
  return sections;
};

/** Minutes and seconds, enough to find a line on the ruler. */
export const beatTime = (frame: number, rate: number): string => {
  const seconds = Math.floor(frame / rate + 1e-6);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const SCRIPT_SHOWN_KEY = "stellar.timeline.showScript";
// Below this window width the script starts closed, so the timeline keeps its room.
const SCRIPT_DEFAULT_OPEN_PX = 1280;

export const readScriptShown = (): boolean => {
  try {
    const stored = window.localStorage.getItem(SCRIPT_SHOWN_KEY);
    if (stored !== null) return stored === "true";
  } catch {
    // Falls through to the width default.
  }
  return window.innerWidth >= SCRIPT_DEFAULT_OPEN_PX;
};

export const writeScriptShown = (shown: boolean) => {
  try {
    window.localStorage.setItem(SCRIPT_SHOWN_KEY, String(shown));
  } catch {
    // Storage is a convenience; the toggle still works for this session.
  }
};
