/**
 * A source's measured sound: its level in dBFS over short windows, and the levels its room
 * tone and its speech sit at. A transcript says when a word was recognised; only the levels
 * say when the recording is quiet, which is where a cut wants to land.
 */

/** Bump when the measurement changes, so levels cached under an older one are made again. */
export const LEVELS_VERSION = 1;
/** Levels are measured on mono audio at this rate, as signed 16-bit samples. */
export const LEVEL_SAMPLE_RATE = 16000;
const WINDOW_SAMPLES = 160;
/** Digital silence, and the lowest level a window reports. */
export const SILENT_DBFS = -100;

export interface AudioLevels {
  /** Seconds per window. */
  readonly step: number;
  /** RMS of each window in whole dBFS, from the first audio sample. */
  readonly db: ReadonlyArray<number>;
  /** Where the recording sits when nobody speaks: the 10th percentile of its windows. */
  readonly roomTone: number;
  /** Where speech sits: the 85th percentile. */
  readonly speech: number;
}

// In a loud room the noise sits within 12 dB of speech: sound has to stand clear of it too.
const ABOVE_ROOM_DB = 6;

const percentile = (counts: ReadonlyArray<number>, total: number, fraction: number) => {
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    seen += counts[i] ?? 0;
    if (seen > total * fraction) return i + SILENT_DBFS;
  }
  return SILENT_DBFS;
};

/** The levels of a list of window levels, with room tone and speech read off their spread. */
export const levelsOf = (db: ReadonlyArray<number>, step: number): AudioLevels => {
  const counts = Array.from({ length: 1 - SILENT_DBFS }, () => 0);
  for (const value of db) {
    const slot = Math.min(Math.max(Math.round(value), SILENT_DBFS), 0) - SILENT_DBFS;
    counts[slot] = (counts[slot] ?? 0) + 1;
  }
  const roomTone = percentile(counts, db.length, 0.1);
  // Read off the windows that stand clear of the room, so a clip that is mostly waiting still
  // reports where its few words sit.
  const loud = counts.map((count, slot) =>
    slot + SILENT_DBFS >= roomTone + ABOVE_ROOM_DB ? count : 0,
  );
  const loudTotal = loud.reduce((sum, count) => sum + count, 0);
  return {
    step,
    db,
    roomTone,
    speech: loudTotal === 0 ? roomTone : percentile(loud, loudTotal, 0.85),
  };
};

/**
 * Measures raw audio as it streams out of a decoder: little-endian signed 16-bit mono at
 * `LEVEL_SAMPLE_RATE`, in chunks of any size. A window left short at the end is dropped.
 */
export const makeLevelMeter = () => {
  const db: Array<number> = [];
  let squares = 0;
  let samples = 0;
  // A chunk can end between a sample's two bytes.
  let lowByte: number | null = null;
  const sample = (low: number, high: number) => {
    const value = ((high << 8) | low) << 16;
    const scaled = (value >> 16) / 32768;
    squares += scaled * scaled;
    samples += 1;
    if (samples < WINDOW_SAMPLES) return;
    const rms = Math.sqrt(squares / samples);
    db.push(rms > 0 ? Math.max(Math.round(20 * Math.log10(rms)), SILENT_DBFS) : SILENT_DBFS);
    squares = 0;
    samples = 0;
  };
  return {
    push: (chunk: Uint8Array) => {
      let at = 0;
      if (lowByte !== null && chunk.length > 0) {
        sample(lowByte, chunk[0] ?? 0);
        lowByte = null;
        at = 1;
      }
      for (; at + 1 < chunk.length; at += 2) sample(chunk[at] ?? 0, chunk[at + 1] ?? 0);
      if (at < chunk.length) lowByte = chunk[at] ?? 0;
    },
    finish: (): AudioLevels => levelsOf(db, WINDOW_SAMPLES / LEVEL_SAMPLE_RATE),
  };
};

// Adapted from Scarlet (Forward-Future, MIT), packages/mcp/src/gap-sound.ts: sound counts when
// it is within 12 dB of where speech sits, and never below -45 dBFS, which is room tone.
const BELOW_SPEECH_DB = 12;
const QUIETEST_SOUND_DBFS = -45;

/** A window at or above this is sound at speaking level. */
export const soundFloor = (levels: AudioLevels): number =>
  Math.max(levels.speech - BELOW_SPEECH_DB, levels.roomTone + ABOVE_ROOM_DB, QUIETEST_SOUND_DBFS);

/** A window at or below this is as quiet as the recording gets between words. */
export const quietCeiling = (levels: AudioLevels): number =>
  Math.min(levels.roomTone + ABOVE_ROOM_DB, soundFloor(levels) - 3);

/**
 * The level a cut at `seconds` is heard at: the louder of the windows either side of that
 * instant. Undefined outside the audio.
 */
export const edgeLevel = (levels: AudioLevels, seconds: number): number | undefined => {
  const at = Math.round(seconds / levels.step);
  if (at < 0 || at > levels.db.length) return undefined;
  const before = levels.db[at - 1];
  const after = levels.db[at];
  if (before === undefined) return after;
  return after === undefined ? before : Math.max(before, after);
};

export interface GapSound {
  /** Seconds of the gap that sound at speaking level. */
  readonly seconds: number;
  /** Each run of a tenth of a second or more, in source seconds. */
  readonly runs: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

const SHORTEST_RUN_SECONDS = 0.1;
/** A word's sound runs a little past its timing either way. */
const WORD_EDGE_SECONDS = 0.05;

/**
 * What sounds between two words: every run at speaking level, clear of each word's own edge.
 * A transcript is silent there, and a pause read from it alone can hold a missed word or half
 * a restart. Undefined when the levels don't cover the gap. Adapted from Scarlet's `gapSound`.
 */
export const gapSound = (
  levels: AudioLevels,
  gap: { readonly start: number; readonly end: number },
): GapSound | undefined => {
  const start = gap.start + WORD_EDGE_SECONDS;
  const end = gap.end - WORD_EDGE_SECONDS;
  if (gap.start < 0 || gap.end > levels.db.length * levels.step + levels.step) return undefined;
  const floor = soundFloor(levels);
  const runs: Array<{ start: number; end: number }> = [];
  let open: number | null = null;
  const close = (at: number) => {
    if (open !== null && at - open >= SHORTEST_RUN_SECONDS - 1e-6) {
      runs.push({ start: open, end: at });
    }
    open = null;
  };
  for (let i = Math.max(0, Math.floor(start / levels.step)); i < levels.db.length; i++) {
    const from = Math.max(start, i * levels.step);
    const to = Math.min(end, (i + 1) * levels.step);
    if (to <= from) break;
    if ((levels.db[i] ?? SILENT_DBFS) >= floor) open ??= from;
    else close(from);
  }
  close(end);
  return { seconds: runs.reduce((sum, run) => sum + run.end - run.start, 0), runs };
};

/**
 * The quiet between two words as heard: from the first window at or under the quiet ceiling
 * to the last, looking a little way into each word since timings run long. Null when the gap
 * has none.
 */
export const quietSpan = (
  levels: AudioLevels,
  gap: { readonly start: number; readonly end: number },
): { readonly start: number; readonly end: number; readonly db: number } | null => {
  const ceiling = quietCeiling(levels);
  const first = Math.max(0, Math.floor((gap.start - WORD_EDGE_SECONDS) / levels.step));
  const last = Math.min(
    levels.db.length - 1,
    Math.ceil((gap.end + WORD_EDGE_SECONDS) / levels.step) - 1,
  );
  let from = -1;
  let to = -1;
  let loudest = SILENT_DBFS;
  for (let i = first; i <= last; i++) {
    if ((levels.db[i] ?? 0) > ceiling) continue;
    if (from < 0) from = i;
    to = i;
  }
  if (from < 0) return null;
  for (let i = from; i <= to; i++) loudest = Math.max(loudest, levels.db[i] ?? SILENT_DBFS);
  return { start: from * levels.step, end: (to + 1) * levels.step, db: loudest };
};
