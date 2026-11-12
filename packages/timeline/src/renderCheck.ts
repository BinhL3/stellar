/**
 * The render check: Premiere's exported file compared with the timeline it was cut from. Stellar
 * has no renderer, so "done" is decided here, from what ffprobe and ffmpeg say about the export.
 * Everything in this file is pure; `renderProbe.ts` runs the tools.
 */
import { layoutTimeline } from "./layout.ts";
import { type Clip, type Timeline, TIMELINE_NAMESPACE } from "./otio.ts";
import { sourceSecondsAt, timeScalarOf } from "./speed.ts";

/** What short-form platforms normalise towards; quieter or louder gets turned up or down. */
export const SHORT_FORM_LOUDNESS_LUFS = -14;
/** How far from the target the integrated loudness may sit before it is worth a note. */
export const LOUDNESS_TOLERANCE_LU = 2;
/** Peaks above this clip once a platform re-encodes the audio. */
export const TRUE_PEAK_MAX_DBTP = -1;
/** The export may be this many frames longer or shorter than the timeline. */
export const DURATION_TOLERANCE_FRAMES = 1;
export const FRAME_RATE_TOLERANCE = 0.01;
/** A cut may show this many export frames either side of where the timeline has it. */
export const CUT_TOLERANCE_FRAMES = 1;
/** Shots this short are flash frames. */
export const FLASH_MAX_FRAMES = 2;
/** Above this share of missing cuts (and at least three) the export is of another cut. */
export const CUT_MISMATCH_FAIL_SHARE = 0.25;
/** Black shorter than this many frames is not reported. */
export const BLACK_MIN_FRAMES = 2;
/** A picture has to hold this long to count as frozen, and audio this long as a silence. */
export const FREEZE_MIN_SECONDS = 1;
export const SILENCE_MIN_SECONDS = 1;
/** Digital silence: a muted or offline clip. Room tone and pauses in speech sit well above it. */
export const SILENCE_NOISE_DB = -60;
/** Codecs the short-form platforms take without transcoding surprises. */
export const DELIVERY_VIDEO_CODECS: ReadonlyArray<string> = ["h264", "hevc"];
export const DELIVERY_AUDIO_CODECS: ReadonlyArray<string> = ["aac"];

/**
 * A cut shows as a frame that differs from the one before it far more than its neighbours do.
 * Differences are mean absolute luma change per pixel, 0 to 255, on a 160 px wide copy.
 * `strong` finds cuts nobody pointed at; `confirm` is the lower bar for a frame the timeline
 * says holds a cut.
 */
export const CUT_DETECTION = {
  /** Frames either side that set the local level of motion. */
  window: 6,
  strong: { min: 10, ratio: 4 },
  confirm: { min: 3, ratio: 2 },
} as const;

const STILL_PATH = /\.(png|jpe?g|heic|tiff?|psd|gif|webp|bmp)$/i;

/** A span of timeline frames, end exclusive. */
export interface FrameSpan {
  readonly start: number;
  readonly end: number;
}

/** A span of the export, in seconds. */
export interface SecondsSpan {
  readonly start: number;
  readonly end: number;
}

export interface TimelineRenderFacts {
  readonly rate: number;
  readonly durationFrames: number;
  /** The sequence's frame size, when the timeline records one. */
  readonly frame: { readonly width: number; readonly height: number } | null;
  /**
   * Frames where the picture changes from one video clip to another. `hard` cuts join different
   * media, so they must show; a jump cut inside one file, or a cut under a transition, may not.
   */
  readonly cuts: ReadonlyArray<{ readonly frame: number; readonly hard: boolean }>;
  /** Nothing on any video track: the export is black here. */
  readonly gaps: ReadonlyArray<FrameSpan>;
  /** A still image is on screen, or no video file is: the picture may hold without a fault. */
  readonly holds: ReadonlyArray<FrameSpan>;
  /** No clip on any audio track. */
  readonly silent: ReadonlyArray<FrameSpan>;
  /** Clips on video tracks no longer than a flash frame. */
  readonly slivers: ReadonlyArray<{
    readonly frame: number;
    readonly frames: number;
    readonly track: string;
    readonly name: string;
  }>;
  readonly hasAudio: boolean;
}

interface Placed {
  readonly start: number;
  readonly end: number;
  readonly target: string;
  readonly clip: Clip;
  /** 0 is the top video track. */
  readonly layer: number;
}

/** The frames in `[0, duration)` not covered by any of `spans`. */
const uncoveredSpans = (spans: ReadonlyArray<FrameSpan>, duration: number): Array<FrameSpan> => {
  const out: Array<FrameSpan> = [];
  let cursor = 0;
  for (const span of spans.toSorted((a, b) => a.start - b.start)) {
    if (span.start > cursor) out.push({ start: cursor, end: Math.min(span.start, duration) });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < duration) out.push({ start: cursor, end: duration });
  return out.filter((span) => span.end > span.start);
};

/** What the render check needs to know about a timeline. */
export const timelineRenderFacts = (timeline: Timeline): TimelineRenderFacts => {
  const layout = layoutTimeline(timeline);
  const enabledTracks = new Set(
    timeline.tracks.children.filter((track) => track.enabled !== false).map((track) => track.name),
  );
  const videoFiles: Array<Placed> = [];
  const pictures: Array<FrameSpan> = [];
  const stills: Array<FrameSpan> = [];
  const audio: Array<FrameSpan> = [];
  const slivers: Array<TimelineRenderFacts["slivers"][number]> = [];
  let layer = 0;
  for (const track of layout.tracks) {
    // Captions are text Premiere keeps apart from the picture: no cut, no cover for black.
    if ((track.metadata?.[TIMELINE_NAMESPACE] as { captions?: boolean } | undefined)?.captions) {
      continue;
    }
    if (track.kind === "Video") layer++;
    if (!enabledTracks.has(track.name)) continue;
    for (const item of track.clips) {
      if (item.clip.enabled === false || item.endFrame <= item.startFrame) continue;
      const span = { start: item.startFrame, end: item.endFrame };
      if (track.kind === "Audio") {
        audio.push(span);
        continue;
      }
      pictures.push(span);
      if (span.end - span.start <= FLASH_MAX_FRAMES) {
        slivers.push({
          frame: span.start,
          frames: span.end - span.start,
          track: track.name,
          name: item.clip.name,
        });
      }
      const target = item.clip.media_references.DEFAULT_MEDIA.target_url;
      if (STILL_PATH.test(target)) stills.push(span);
      else if (target !== "")
        videoFiles.push({ ...span, target, clip: item.clip, layer: layer - 1 });
    }
  }

  // The picture at each frame is the highest video file there; where that changes is a cut.
  const edges = [...new Set(videoFiles.flatMap((clip) => [clip.start, clip.end]))].toSorted(
    (a, b) => a - b,
  );
  const transitions = timeline.tracks.children.flatMap(
    (track) =>
      (
        track.metadata["premiere"] as
          | { transitions?: ReadonlyArray<{ startFrame: number; endFrame: number }> }
          | undefined
      )?.transitions ?? [],
  );
  const topAt = (frame: number) =>
    videoFiles
      .filter((clip) => clip.start <= frame && frame < clip.end)
      .toSorted((a, b) => a.layer - b.layer)[0];
  const cuts: Array<TimelineRenderFacts["cuts"][number]> = [];
  for (const frame of edges) {
    if (frame <= 0 || frame >= layout.durationFrames) continue;
    const before = topAt(frame - 1);
    const after = topAt(frame);
    if (before === after) continue;
    const sameMedia = before !== undefined && after !== undefined && before.target === after.target;
    if (sameMedia) {
      const scalar = timeScalarOf(before.clip);
      const sourceBefore = sourceSecondsAt(before.clip, (frame - before.start) / layout.rate);
      const sourceAfter = sourceSecondsAt(after.clip, (frame - after.start) / layout.rate);
      // A razor cut that removed nothing plays straight through, at whatever speed both run.
      if (
        scalar === timeScalarOf(after.clip) &&
        Math.abs(sourceBefore - sourceAfter) < (1.5 * Math.abs(scalar)) / layout.rate
      ) {
        continue;
      }
    }
    const dissolved = transitions.some(
      (transition) => transition.startFrame <= frame && frame <= transition.endFrame,
    );
    cuts.push({ frame, hard: !sameMedia && !dissolved });
  }

  const frame = (
    timeline.metadata[TIMELINE_NAMESPACE] as
      | { frame?: { width: number; height: number } }
      | undefined
  )?.frame;
  return {
    rate: layout.rate,
    durationFrames: layout.durationFrames,
    frame: frame === undefined ? null : { width: frame.width, height: frame.height },
    cuts,
    gaps: uncoveredSpans(pictures, layout.durationFrames),
    holds: [...uncoveredSpans(videoFiles, layout.durationFrames), ...stills],
    silent: uncoveredSpans(audio, layout.durationFrames),
    slivers,
    hasAudio: audio.length > 0,
  };
};

/** The container facts ffprobe reports for an export. */
export interface ExportProbe {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** Seconds of picture. */
  readonly duration: number;
  readonly videoCodec: string | null;
  /** Null when the file has no audio stream. */
  readonly audioCodec: string | null;
}

const ratio = (text: string | undefined): number => {
  const [top, bottom = "1"] = (text ?? "").split("/");
  const value = Number(top) / Number(bottom);
  return Number.isFinite(value) ? value : 0;
};

/** Reads `ffprobe -show_entries stream=...:format=duration -of json`; null without a picture. */
export const parseExportProbe = (value: unknown): ExportProbe | null => {
  const parsed = value as {
    streams?: ReadonlyArray<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      duration?: string;
      disposition?: { attached_pic?: number };
    }>;
    format?: { duration?: string };
  };
  const streams = parsed.streams ?? [];
  const video = streams.find(
    (stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1,
  );
  if (video === undefined) return null;
  const audio = streams.find((stream) => stream.codec_type === "audio");
  // The container's length includes audio padding; the picture's own length is the one to compare.
  const duration = Number(video.duration ?? parsed.format?.duration ?? 0);
  return {
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: ratio(video.avg_frame_rate) || ratio(video.r_frame_rate),
    duration: Number.isFinite(duration) ? duration : 0,
    videoCodec: video.codec_name ?? null,
    audioCodec: audio === undefined ? null : (audio.codec_name ?? "unknown"),
  };
};

/** What the ffmpeg filters found in an export's picture and sound. */
export interface ExportAnalysis {
  readonly black: ReadonlyArray<SecondsSpan>;
  readonly frozen: ReadonlyArray<SecondsSpan>;
  /** By frame: how much it differs from the frame before. Null when the picture wasn't read. */
  readonly diffs: ReadonlyArray<number> | null;
  readonly silence: ReadonlyArray<SecondsSpan>;
  /** Integrated loudness in LUFS and true peak in dBTP; null with no measurable audio. */
  readonly loudness: number | null;
  readonly truePeak: number | null;
}

/** Each `key=value` a `metadata=print` filter wrote, with the time of the frame it was on. */
const printedMetadata = (text: string): Array<{ time: number; key: string; value: number }> => {
  const out: Array<{ time: number; key: string; value: number }> = [];
  let time = 0;
  for (const line of text.split("\n")) {
    const header = /pts_time:(-?[\d.]+)/.exec(line);
    if (header !== null) {
      time = Number(header[1]);
      continue;
    }
    const split = line.indexOf("=");
    if (split < 0) continue;
    const value = Number(line.slice(split + 1));
    if (Number.isFinite(value)) out.push({ time, key: line.slice(0, split).trim(), value });
  }
  return out;
};

/** Pairs start and end marks in time order; a span still open at the end runs to `duration`. */
const spansFrom = (
  starts: ReadonlyArray<number>,
  ends: ReadonlyArray<number>,
  duration: number,
): Array<SecondsSpan> => {
  const sortedEnds = ends.toSorted((a, b) => a - b);
  return starts
    .toSorted((a, b) => a - b)
    .map((start) => ({ start, end: sortedEnds.find((end) => end > start) ?? duration }))
    .filter((span) => span.end > span.start);
};

/** Reads the picture pass's printed metadata (see `VIDEO_ANALYSIS_FILTER`). */
export const parseVideoAnalysis = (
  text: string,
  probe: Pick<ExportProbe, "fps" | "duration">,
): Pick<ExportAnalysis, "black" | "frozen" | "diffs"> => {
  const entries = printedMetadata(text);
  const values = (key: string) =>
    entries.filter((entry) => entry.key === key).map((entry) => entry.value);
  const diffs: Array<number> = [];
  for (const entry of entries) {
    if (entry.key !== "lavfi.signalstats.YAVG") continue;
    const frame = Math.round(entry.time * probe.fps);
    if (frame >= 0) diffs[frame] = entry.value;
  }
  return {
    black: spansFrom(values("lavfi.black_start"), values("lavfi.black_end"), probe.duration),
    frozen: spansFrom(
      values("lavfi.freezedetect.freeze_start"),
      values("lavfi.freezedetect.freeze_end"),
      probe.duration,
    ),
    diffs: diffs.length === 0 ? null : Array.from(diffs, (diff) => diff ?? 0),
  };
};

/** Reads the sound pass's printed metadata (see `AUDIO_ANALYSIS_FILTER`). */
export const parseAudioAnalysis = (
  text: string,
  duration: number,
): Pick<ExportAnalysis, "silence" | "loudness" | "truePeak"> => {
  const entries = printedMetadata(text);
  const values = (key: string) =>
    entries.filter((entry) => entry.key === key).map((entry) => entry.value);
  const loudness = values("lavfi.r128.I").at(-1);
  const peak = Math.max(0, ...values("lavfi.r128.true_peak"));
  return {
    silence: spansFrom(values("lavfi.silence_start"), values("lavfi.silence_end"), duration),
    // The meter reads -70 LUFS for a file with nothing above its gate.
    loudness: loudness === undefined || loudness <= -69 ? null : loudness,
    truePeak: peak > 0 ? 20 * Math.log10(peak) : null,
  };
};

/** One ffmpeg pass over the picture; every finding is printed as frame metadata on stdout. */
export const videoAnalysisFilter = (fps: number): string =>
  [
    "scale=160:-2",
    `blackdetect=d=${(BLACK_MIN_FRAMES / (fps || 30)).toFixed(4)}:pix_th=0.05`,
    "metadata=print:key=lavfi.black_start:file=-",
    "metadata=print:key=lavfi.black_end:file=-",
    `freezedetect=n=0.003:d=${FREEZE_MIN_SECONDS}`,
    "metadata=print:key=lavfi.freezedetect.freeze_start:file=-",
    "metadata=print:key=lavfi.freezedetect.freeze_end:file=-",
    "tblend=all_mode=difference",
    "signalstats",
    "metadata=print:key=lavfi.signalstats.YAVG:file=-",
  ].join(",");

export const AUDIO_ANALYSIS_FILTER = [
  `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SECONDS}`,
  "ametadata=print:key=lavfi.silence_start:file=-",
  "ametadata=print:key=lavfi.silence_end:file=-",
  "ebur128=metadata=1:peak=true",
  "ametadata=print:key=lavfi.r128.I:file=-",
  "ametadata=print:key=lavfi.r128.true_peak:file=-",
].join(",");

/** The level of motion around a frame: the upper quartile of its neighbours' differences. */
const motionAround = (diffs: ReadonlyArray<number>, frame: number): number => {
  const near: Array<number> = [];
  for (let offset = -CUT_DETECTION.window; offset <= CUT_DETECTION.window; offset++) {
    const value = diffs[frame + offset];
    if (offset !== 0 && value !== undefined) near.push(value);
  }
  near.sort((a, b) => a - b);
  return near[Math.floor(0.75 * (near.length - 1))] ?? 0;
};

const isCut = (
  diffs: ReadonlyArray<number>,
  frame: number,
  bar: { readonly min: number; readonly ratio: number },
): boolean => {
  const diff = diffs[frame] ?? 0;
  return diff >= bar.min && diff >= bar.ratio * motionAround(diffs, frame);
};

/** Frames that open a new shot, found without the timeline's help. */
export const detectCuts = (diffs: ReadonlyArray<number>): Array<number> =>
  diffs.flatMap((_, frame) => (isCut(diffs, frame, CUT_DETECTION.strong) ? [frame] : []));

/** Shots of one or two frames: a cut in and a cut out that close together. */
export const detectFlashes = (
  diffs: ReadonlyArray<number>,
): Array<{ readonly frame: number; readonly frames: number }> => {
  const cuts = detectCuts(diffs);
  return cuts.flatMap((frame, index) => {
    const next = cuts[index + 1];
    return next !== undefined && next - frame <= FLASH_MAX_FRAMES
      ? [{ frame, frames: next - frame }]
      : [];
  });
};

export type RenderCheckLevel = "pass" | "warn" | "fail";

export interface RenderCheckItem {
  readonly id:
    | "resolution"
    | "frameRate"
    | "duration"
    | "codecs"
    | "audio"
    | "black"
    | "frozen"
    | "silence"
    | "loudness"
    | "truePeak"
    | "cuts"
    | "flashFrames";
  readonly level: RenderCheckLevel;
  readonly title: string;
  readonly detail: string;
}

const two = (value: number) => String(value).padStart(2, "0");

/** A place in the export as `0:04.20 (frame 126)`. */
const place = (seconds: number, fps: number): string => {
  const whole = Math.floor(seconds);
  const hundredths = Math.floor((seconds - whole) * 100 + 1e-6);
  return `${Math.floor(whole / 60)}:${two(whole % 60)}.${two(hundredths)} (frame ${Math.round(seconds * fps)})`;
};

const seconds = (value: number) => `${value.toFixed(value < 10 ? 2 : 1)} s`;
const rateText = (fps: number) => fps.toFixed(3).replace(/\.?0+$/, "");

/** Seconds of `span` that no explaining span covers, each of those widened by `slack`. */
const unexplained = (
  span: SecondsSpan,
  explained: ReadonlyArray<SecondsSpan>,
  slack: number,
): number => {
  let left = span.end - span.start;
  let cursor = span.start;
  for (const cover of explained.toSorted((a, b) => a.start - b.start)) {
    const start = Math.max(cursor, cover.start - slack);
    const end = Math.min(span.end, cover.end + slack);
    if (end <= start) continue;
    left -= end - start;
    cursor = end;
  }
  return left;
};

const inSeconds = (spans: ReadonlyArray<FrameSpan>, rate: number): Array<SecondsSpan> =>
  spans.map((span) => ({ start: span.start / rate, end: span.end / rate }));

const listed = (places: ReadonlyArray<string>, limit = 4): string =>
  places.length <= limit
    ? places.join(", ")
    : `${places.slice(0, limit).join(", ")} and ${places.length - limit} more`;

const worst = (levels: ReadonlyArray<RenderCheckLevel>): RenderCheckLevel =>
  levels.includes("fail") ? "fail" : levels.includes("warn") ? "warn" : "pass";

export const reportLevel = (items: ReadonlyArray<RenderCheckItem>): RenderCheckLevel =>
  worst(items.map((item) => item.level));

/** Every check of an export against its timeline, in the order they are shown. */
export const compareRender = (
  facts: TimelineRenderFacts,
  probe: ExportProbe,
  analysis: ExportAnalysis,
): Array<RenderCheckItem> => {
  const items: Array<RenderCheckItem> = [];
  const fps = probe.fps || facts.rate;
  const frameSeconds = 1 / fps;

  const size = `${probe.width}x${probe.height}`;
  items.push(
    facts.frame === null
      ? {
          id: "resolution",
          level: "pass",
          title: "Resolution",
          detail: `${size}. The timeline records no frame size to compare it with.`,
        }
      : facts.frame.width === probe.width && facts.frame.height === probe.height
        ? { id: "resolution", level: "pass", title: "Resolution", detail: size }
        : {
            id: "resolution",
            level: "fail",
            title: "Resolution",
            detail: `The export is ${size}; the sequence is ${facts.frame.width}x${facts.frame.height}.`,
          },
  );

  items.push(
    Math.abs(probe.fps - facts.rate) <= FRAME_RATE_TOLERANCE
      ? {
          id: "frameRate",
          level: "pass",
          title: "Frame rate",
          detail: `${rateText(probe.fps)} fps`,
        }
      : {
          id: "frameRate",
          level: "fail",
          title: "Frame rate",
          detail: `The export is ${rateText(probe.fps)} fps; the sequence is ${rateText(facts.rate)} fps.`,
        },
  );

  const expectedSeconds = facts.durationFrames / facts.rate;
  const offBy = (probe.duration - expectedSeconds) * facts.rate;
  items.push(
    Math.abs(offBy) <= DURATION_TOLERANCE_FRAMES + 0.01
      ? {
          id: "duration",
          level: "pass",
          title: "Length",
          detail: `${seconds(probe.duration)}, the timeline's length`,
        }
      : {
          id: "duration",
          level: "fail",
          title: "Length",
          detail: `The export is ${seconds(probe.duration)}, ${Math.abs(Math.round(offBy))} frames ${offBy > 0 ? "longer" : "shorter"} than the timeline (${seconds(expectedSeconds)}).`,
        },
  );

  const oddCodecs = [
    ...(probe.videoCodec !== null && DELIVERY_VIDEO_CODECS.includes(probe.videoCodec)
      ? []
      : [`video is ${probe.videoCodec ?? "unknown"}`]),
    ...(probe.audioCodec === null || DELIVERY_AUDIO_CODECS.includes(probe.audioCodec)
      ? []
      : [`audio is ${probe.audioCodec}`]),
  ];
  items.push(
    oddCodecs.length === 0
      ? {
          id: "codecs",
          level: "pass",
          title: "Codecs",
          detail: [probe.videoCodec, probe.audioCodec].filter((codec) => codec !== null).join(", "),
        }
      : {
          id: "codecs",
          level: "warn",
          title: "Codecs",
          detail: `Not a delivery format: ${oddCodecs.join(" and ")}. Platforms expect ${DELIVERY_VIDEO_CODECS.join(" or ")} with ${DELIVERY_AUDIO_CODECS.join(" or ")}.`,
        },
  );

  const hasAudio = probe.audioCodec !== null;
  items.push(
    hasAudio
      ? { id: "audio", level: "pass", title: "Audio", detail: "The export has sound." }
      : facts.hasAudio
        ? {
            id: "audio",
            level: "fail",
            title: "Audio",
            detail: "The export has no audio track; the timeline has audio clips.",
          }
        : {
            id: "audio",
            level: "pass",
            title: "Audio",
            detail: "No audio track, and none on the timeline.",
          },
  );

  const gaps = inSeconds(facts.gaps, facts.rate);
  const black = analysis.black.map((span) => ({
    span,
    stray: unexplained(span, gaps, frameSeconds) > BLACK_MIN_FRAMES * frameSeconds,
  }));
  const strayBlack = black.filter((entry) => entry.stray);
  const describe = (span: SecondsSpan) =>
    `${seconds(span.end - span.start)} at ${place(span.start, fps)}`;
  items.push(
    black.length === 0
      ? { id: "black", level: "pass", title: "Black frames", detail: "None." }
      : strayBlack.length > 0
        ? {
            id: "black",
            level: "fail",
            title: "Black frames",
            detail: `Black the timeline doesn't explain: ${listed(strayBlack.map((entry) => describe(entry.span)))}.`,
          }
        : {
            id: "black",
            level: "warn",
            title: "Black frames",
            detail: `Black where the timeline has a gap: ${listed(black.map((entry) => describe(entry.span)))}.`,
          },
  );

  const holds = [...inSeconds(facts.holds, facts.rate), ...analysis.black];
  const strayFreezes = analysis.frozen.filter(
    (span) => unexplained(span, holds, 2 * frameSeconds) > FREEZE_MIN_SECONDS / 2,
  );
  items.push(
    strayFreezes.length === 0
      ? {
          id: "frozen",
          level: "pass",
          title: "Frozen picture",
          detail: analysis.frozen.length === 0 ? "None." : "Only where the timeline holds a still.",
        }
      : {
          id: "frozen",
          level: "warn",
          title: "Frozen picture",
          detail: `The picture stops moving though the timeline has video there: ${listed(strayFreezes.map(describe))}. A clip may be offline or stalled.`,
        },
  );

  if (hasAudio) {
    const quiet = inSeconds(facts.silent, facts.rate);
    const straySilence = analysis.silence.filter(
      (span) => unexplained(span, quiet, 2 * frameSeconds) > SILENCE_MIN_SECONDS / 2,
    );
    items.push(
      straySilence.length === 0
        ? {
            id: "silence",
            level: "pass",
            title: "Silences",
            detail:
              analysis.silence.length === 0
                ? "None."
                : "Only where the timeline has no audio clip.",
          }
        : {
            id: "silence",
            level: "warn",
            title: "Silences",
            detail: `Silent though the timeline has audio there: ${listed(straySilence.map(describe))}. A clip may be muted or offline.`,
          },
    );

    const { loudness, truePeak } = analysis;
    const target = `${SHORT_FORM_LOUDNESS_LUFS} LUFS`;
    items.push(
      loudness === null
        ? {
            id: "loudness",
            level: "warn",
            title: "Loudness",
            detail: "Nothing loud enough to measure.",
          }
        : Math.abs(loudness - SHORT_FORM_LOUDNESS_LUFS) <= LOUDNESS_TOLERANCE_LU
          ? {
              id: "loudness",
              level: "pass",
              title: "Loudness",
              detail: `${loudness.toFixed(1)} LUFS (target ${target})`,
            }
          : {
              id: "loudness",
              level: "warn",
              title: "Loudness",
              detail: `${loudness.toFixed(1)} LUFS, ${Math.abs(loudness - SHORT_FORM_LOUDNESS_LUFS).toFixed(1)} LU ${loudness < SHORT_FORM_LOUDNESS_LUFS ? "quieter" : "louder"} than the ${target} short-form target.`,
            },
    );
    if (truePeak !== null) {
      items.push(
        truePeak <= TRUE_PEAK_MAX_DBTP
          ? {
              id: "truePeak",
              level: "pass",
              title: "True peak",
              detail: `${truePeak.toFixed(1)} dBTP (limit ${TRUE_PEAK_MAX_DBTP})`,
            }
          : {
              id: "truePeak",
              level: "warn",
              title: "True peak",
              detail: `${truePeak.toFixed(1)} dBTP, above the ${TRUE_PEAK_MAX_DBTP} dBTP limit: it can clip when a platform re-encodes it.`,
            },
      );
    }
  }

  const { diffs } = analysis;
  if (diffs !== null) {
    const hard = facts.cuts.filter((cut) => cut.hard);
    const missing = hard.filter((cut) => {
      const frame = Math.round((cut.frame / facts.rate) * fps);
      for (let offset = -CUT_TOLERANCE_FRAMES; offset <= CUT_TOLERANCE_FRAMES; offset++) {
        if (isCut(diffs, frame + offset, CUT_DETECTION.confirm)) return false;
      }
      return true;
    });
    const places = listed(missing.map((cut) => place(cut.frame / facts.rate, fps)));
    const within = `within ${CUT_TOLERANCE_FRAMES} frame`;
    items.push(
      hard.length === 0
        ? {
            id: "cuts",
            level: "pass",
            title: "Cuts",
            detail: "The timeline has no cuts between different clips to look for.",
          }
        : missing.length === 0
          ? {
              id: "cuts",
              level: "pass",
              title: "Cuts",
              detail: `All ${hard.length} cuts between different clips show ${within} of the timeline.`,
            }
          : missing.length >= 3 && missing.length > hard.length * CUT_MISMATCH_FAIL_SHARE
            ? {
                id: "cuts",
                level: "fail",
                title: "Cuts",
                detail: `This export isn't this cut: ${missing.length} of ${hard.length} cuts don't show ${within} of the timeline (${places}). It may be an older export.`,
              }
            : {
                id: "cuts",
                level: "warn",
                title: "Cuts",
                detail: `${missing.length} of ${hard.length} cuts don't show ${within} of the timeline: ${places}.`,
              },
    );

    const flashes = detectFlashes(diffs).map((flash) => {
      const start = (flash.frame / fps) * facts.rate;
      const sliver = facts.slivers.find(
        (candidate) =>
          candidate.frame < start + flash.frames + CUT_TOLERANCE_FRAMES &&
          start - CUT_TOLERANCE_FRAMES < candidate.frame + candidate.frames,
      );
      return { ...flash, sliver };
    });
    const flashText = flashes.map((flash) =>
      flash.sliver === undefined
        ? `${flash.frames}-frame flash at ${place(flash.frame / fps, fps)}`
        : `${flash.sliver.track} ${flash.sliver.name} is ${flash.sliver.frames} ${flash.sliver.frames === 1 ? "frame" : "frames"} long at ${place(flash.frame / fps, fps)}`,
    );
    items.push(
      flashes.length === 0
        ? { id: "flashFrames", level: "pass", title: "Flash frames", detail: "None." }
        : flashes.some((flash) => flash.sliver !== undefined)
          ? {
              id: "flashFrames",
              level: "fail",
              title: "Flash frames",
              detail: `Leftover slivers flash on screen: ${listed(flashText)}.`,
            }
          : {
              id: "flashFrames",
              level: "warn",
              title: "Flash frames",
              detail: `Shots of one or two frames the timeline doesn't have: ${listed(flashText)}.`,
            },
    );
  }
  return items;
};

/** The contact sheet shows at most this many frames, this many of them spread evenly. */
export const CONTACT_SHEET_MAX_TILES = 48;
export const CONTACT_SHEET_EVEN_TILES = 12;
const CONTACT_SHEET_TILE_WIDTH = 216;

export interface ContactSheetTile {
  /** The export's frame number. */
  readonly frame: number;
  readonly seconds: number;
  /** `cut` is the frame just after a timeline cut; `flash` a flash frame the check found. */
  readonly kind: "even" | "cut" | "flash";
}

/** Which frames go on the sheet: an even spread, each cut's first clean frame, and flashes. */
export const contactSheetTiles = (
  facts: Pick<TimelineRenderFacts, "rate" | "cuts">,
  probe: Pick<ExportProbe, "fps" | "duration">,
  flashes: ReadonlyArray<{ readonly frame: number }> = [],
): Array<ContactSheetTile> => {
  const fps = probe.fps || facts.rate;
  const last = Math.max(0, Math.round(probe.duration * fps) - 1);
  const tiles = new Map<number, ContactSheetTile["kind"]>();
  const add = (frame: number, kind: ContactSheetTile["kind"]) => {
    const clamped = Math.min(last, Math.max(0, Math.round(frame)));
    const existing = tiles.get(clamped);
    if (existing === undefined || existing === "even") tiles.set(clamped, kind);
  };
  for (const flash of flashes.slice(0, 6)) add(flash.frame, "flash");
  // One frame past the cut, so a blended or late first frame doesn't stand in for the shot.
  const cutFrames = facts.cuts.map((cut) => (cut.frame / facts.rate) * fps + 1);
  const room = CONTACT_SHEET_MAX_TILES - CONTACT_SHEET_EVEN_TILES - tiles.size;
  const step = Math.max(1, cutFrames.length / room);
  for (let index = 0; Math.floor(index) < cutFrames.length; index += step) {
    add(cutFrames[Math.floor(index)] ?? 0, "cut");
  }
  for (let index = 0; index < CONTACT_SHEET_EVEN_TILES; index++) {
    add(((index + 0.5) / CONTACT_SHEET_EVEN_TILES) * (last + 1), "even");
  }
  return [...tiles]
    .toSorted((a, b) => a[0] - b[0])
    .map(([frame, kind]) => ({ frame, seconds: frame / fps, kind }));
};

/**
 * The ffmpeg filter that lays the tiles out in one image. With `labels`, each tile carries its
 * frame number and time, and cut and flash tiles say so; without (an ffmpeg built without
 * drawtext), the tiles are bare and the caller lists what each one is.
 */
export const contactSheetFilter = (
  tiles: ReadonlyArray<ContactSheetTile>,
  probe: Pick<ExportProbe, "fps" | "width" | "height">,
  labels: boolean,
): string => {
  const columns = Math.min(tiles.length, probe.height >= probe.width ? 8 : 4);
  const rows = Math.ceil(tiles.length / columns);
  const width =
    probe.height >= probe.width ? CONTACT_SHEET_TILE_WIDTH : 2 * CONTACT_SHEET_TILE_WIDTH;
  const half = 0.5 / probe.fps;
  const when = (kind: ContactSheetTile["kind"]) =>
    tiles
      .filter((tile) => tile.kind === kind)
      .map(
        (tile) =>
          `between(t,${(tile.seconds - half).toFixed(5)},${(tile.seconds + half).toFixed(5)})`,
      )
      .join("+");
  const tag = (kind: ContactSheetTile["kind"], text: string, colour: string) =>
    when(kind) === ""
      ? []
      : [
          `drawtext=text='${text}':x=4:y=4:fontsize=15:fontcolor=white:box=1:boxborderw=3:boxcolor=${colour}@0.9:enable='${when(kind)}'`,
        ];
  return [
    `select='${tiles.map((tile) => `eq(n,${tile.frame})`).join("+")}'`,
    `scale=${width}:-2`,
    ...(labels
      ? [
          `drawtext=text='%{eif\\:t*${probe.fps.toFixed(5)}+0.5\\:d}  %{pts\\:hms}':x=4:y=h-th-6:fontsize=13:fontcolor=white:box=1:boxborderw=3:boxcolor=black@0.65`,
          ...tag("cut", "CUT", "0x2563eb"),
          ...tag("flash", "FLASH", "0xdc2626"),
        ]
      : []),
    `tile=${columns}x${rows}:padding=4:margin=4:color=0x111111`,
  ].join(",");
};
