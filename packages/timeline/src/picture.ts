/**
 * What a footage clip shows, measured without a model: cuts, camera movement, and stretches no
 * editor would use. Small frames sampled from the proxy keep a minute of footage to about a
 * second. Faces are left to the description model: detecting them well needs a model file.
 */

/** Frames per second the picture pass samples. Cuts and segment edges land within 1/10 s. */
export const PICTURE_SAMPLE_RATE = 10;
/** Short edge of a sampled frame, in pixels. */
export const PICTURE_SHORT_EDGE = 64;
/** Bumped when the measures or their reading change, so every clip is measured again. */
export const PICTURE_VERSION = 1;

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/** The sampled frame's size for a clip of this display size: short edge 64, both even. */
export const analysisSize = (width: number, height: number): FrameSize => {
  const even = (value: number) => Math.max(2, 2 * Math.round(value / 2));
  if (width <= 0 || height <= 0) return { width: PICTURE_SHORT_EDGE, height: PICTURE_SHORT_EDGE };
  return width >= height
    ? { width: even((PICTURE_SHORT_EDGE * width) / height), height: PICTURE_SHORT_EDGE }
    : { width: PICTURE_SHORT_EDGE, height: even((PICTURE_SHORT_EDGE * height) / width) };
};

/** How the whole frame moved from one sample to the next. */
export interface GlobalMotion {
  /** Content shift in sampled pixels; content moving left is the camera turning right. */
  readonly dx: number;
  readonly dy: number;
  /** Scale change: above 0 when the content grows (pushing in or walking forward). */
  readonly zoom: number;
  /** Share of textured blocks the one movement explains. */
  readonly fit: number;
}

/** Per-sample measures of a clip's picture; index 0 is the first sample. */
export interface PictureTrack {
  readonly size: FrameSize;
  /** Mean luma, 0–255. */
  readonly luma: ReadonlyArray<number>;
  /** Luma standard deviation: near 0 for a flat frame (a covered lens, a wall). */
  readonly contrast: ReadonlyArray<number>;
  /** Colour histogram distance to the sample before, 0–1. */
  readonly histDist: ReadonlyArray<number>;
  /** Mean absolute luma difference to the sample before, 0–1. */
  readonly pixDiff: ReadonlyArray<number>;
  /** Share of pixels that changed noticeably since the sample before. */
  readonly changed: ReadonlyArray<number>;
  /**
   * Difference to the closest of the two samples before the one before, over `pixDiff`: low
   * when a flash or glitch of a sample or two ends and the picture is back to what it was.
   */
  readonly back: ReadonlyArray<number>;
  /** Null when too little of the frame has texture to tell. */
  readonly motion: ReadonlyArray<GlobalMotion | null>;
}

const HIST_BINS = 4;
const BLOCK = 8;
const SEARCH = 5;
const MIN_BLOCK_VARIANCE = 30;
const INLIER_PX = 1.25;

const toGray = (rgb: Uint8Array, pixels: number): Uint8Array => {
  const gray = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    gray[i] = (rgb[3 * i]! * 77 + rgb[3 * i + 1]! * 150 + rgb[3 * i + 2]! * 29) >> 8;
  }
  return gray;
};

const histogram = (rgb: Uint8Array, pixels: number): Float64Array => {
  const shift = 8 - Math.log2(HIST_BINS);
  const bins = new Float64Array(HIST_BINS ** 3);
  for (let i = 0; i < pixels; i++) {
    const r = rgb[3 * i]! >> shift;
    const g = rgb[3 * i + 1]! >> shift;
    const b = rgb[3 * i + 2]! >> shift;
    bins[(r * HIST_BINS + g) * HIST_BINS + b]! += 1 / pixels;
  }
  return bins;
};

/** Bhattacharyya distance between two normalized histograms: 0 alike, 1 nothing shared. */
const histDistance = (a: Float64Array, b: Float64Array): number => {
  let shared = 0;
  for (let i = 0; i < a.length; i++) shared += Math.sqrt(a[i]! * b[i]!);
  return Math.sqrt(Math.max(0, 1 - shared));
};

const meanAbsDiff = (a: Uint8Array, b: Uint8Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length / 255;
};

const lumaStats = (gray: Uint8Array) => {
  let sum = 0;
  let squares = 0;
  for (const value of gray) {
    sum += value;
    squares += value * value;
  }
  const mean = sum / gray.length;
  return { mean, std: Math.sqrt(Math.max(0, squares / gray.length - mean * mean)) };
};

/**
 * The one shift-and-zoom that best explains how blocks of `prev` moved into `next`, found by
 * block matching and a least-squares fit refit on the blocks it explains.
 */
export const globalMotion = (
  prev: Uint8Array,
  next: Uint8Array,
  size: FrameSize,
): GlobalMotion | null => {
  const { width, height } = size;
  const centreX = width / 2;
  const centreY = height / 2;
  const points: Array<{ x: number; y: number; vx: number; vy: number }> = [];
  for (let top = SEARCH; top + BLOCK + SEARCH <= height; top += BLOCK) {
    for (let left = SEARCH; left + BLOCK + SEARCH <= width; left += BLOCK) {
      let sum = 0;
      let squares = 0;
      for (let y = 0; y < BLOCK; y++) {
        for (let x = 0; x < BLOCK; x++) {
          const value = prev[(top + y) * width + left + x]!;
          sum += value;
          squares += value * value;
        }
      }
      const count = BLOCK * BLOCK;
      if (squares / count - (sum / count) ** 2 < MIN_BLOCK_VARIANCE) continue;
      let best = Number.POSITIVE_INFINITY;
      let total = 0;
      let bestU = 0;
      let bestV = 0;
      for (let v = -SEARCH; v <= SEARCH; v++) {
        for (let u = -SEARCH; u <= SEARCH; u++) {
          let sad = 0;
          for (let y = 0; y < BLOCK; y++) {
            const from = (top + y) * width + left;
            const to = (top + y + v) * width + left + u;
            for (let x = 0; x < BLOCK; x++) sad += Math.abs(prev[from + x]! - next[to + x]!);
          }
          total += sad;
          if (
            sad < best ||
            (sad === best && Math.abs(u) + Math.abs(v) < Math.abs(bestU) + Math.abs(bestV))
          ) {
            best = sad;
            bestU = u;
            bestV = v;
          }
        }
      }
      // A match no better than the average offset is a block that could be anywhere.
      if (best > 0.7 * (total / (2 * SEARCH + 1) ** 2)) continue;
      points.push({
        x: left + BLOCK / 2 - centreX,
        y: top + BLOCK / 2 - centreY,
        vx: bestU,
        vy: bestV,
      });
    }
  }
  if (points.length < 6) return null;
  const fit = (used: ReadonlyArray<(typeof points)[number]>) => {
    const n = used.length;
    let mx = 0;
    let my = 0;
    let mvx = 0;
    let mvy = 0;
    for (const point of used) {
      mx += point.x / n;
      my += point.y / n;
      mvx += point.vx / n;
      mvy += point.vy / n;
    }
    let numerator = 0;
    let denominator = 0;
    for (const point of used) {
      numerator += (point.x - mx) * (point.vx - mvx) + (point.y - my) * (point.vy - mvy);
      denominator += (point.x - mx) ** 2 + (point.y - my) ** 2;
    }
    const zoom = denominator > 0 ? numerator / denominator : 0;
    return { zoom, dx: mvx - zoom * mx, dy: mvy - zoom * my };
  };
  const residual = (model: ReturnType<typeof fit>, point: (typeof points)[number]) =>
    Math.hypot(
      model.zoom * point.x + model.dx - point.vx,
      model.zoom * point.y + model.dy - point.vy,
    );
  let model = fit(points);
  for (let round = 0; round < 2; round++) {
    const inliers = points.filter((point) => residual(model, point) <= INLIER_PX);
    if (inliers.length < 4) break;
    model = fit(inliers);
  }
  const explained = points.filter((point) => residual(model, point) <= INLIER_PX).length;
  return { ...model, fit: explained / points.length };
};

/**
 * Collects a clip's measures from raw RGB frames as ffmpeg writes them, a chunk at a time, so
 * a long clip never holds more than a few frames.
 */
export const makePictureMeter = (size: FrameSize) => {
  const pixels = size.width * size.height;
  const frameBytes = pixels * 3;
  const pending = new Uint8Array(frameBytes);
  let filled = 0;
  const luma: Array<number> = [];
  const contrast: Array<number> = [];
  const histDist: Array<number> = [];
  const pixDiff: Array<number> = [];
  const changed: Array<number> = [];
  const back: Array<number> = [];
  const motion: Array<GlobalMotion | null> = [];
  // The last three gray frames, newest last, and the newest histogram.
  const recent: Array<Uint8Array> = [];
  let lastHist: Float64Array | null = null;
  let lastStd = 0;

  const take = (rgb: Uint8Array) => {
    const gray = toGray(rgb, pixels);
    const hist = histogram(rgb, pixels);
    const { mean, std } = lumaStats(gray);
    const prev = recent.at(-1);
    luma.push(mean);
    contrast.push(std);
    if (prev === undefined || lastHist === null) {
      histDist.push(0);
      pixDiff.push(0);
      changed.push(0);
      back.push(1);
      motion.push(null);
    } else {
      const diff = meanAbsDiff(prev, gray);
      const threshold = Math.max(6, 0.35 * Math.min(std, lastStd));
      let moved = 0;
      for (let i = 0; i < pixels; i++) if (Math.abs(prev[i]! - gray[i]!) > threshold) moved++;
      histDist.push(histDistance(lastHist, hist));
      pixDiff.push(diff);
      changed.push(moved / pixels);
      const earlier = recent.slice(0, -1).map((frame) => meanAbsDiff(frame, gray));
      back.push(earlier.length === 0 || diff === 0 ? 1 : Math.min(...earlier) / diff);
      motion.push(globalMotion(prev, gray, size));
    }
    recent.push(gray);
    if (recent.length > 3) recent.shift();
    lastHist = hist;
    lastStd = std;
  };

  return {
    push: (chunk: Uint8Array) => {
      let offset = 0;
      while (offset < chunk.length) {
        const count = Math.min(frameBytes - filled, chunk.length - offset);
        pending.set(chunk.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === frameBytes) {
          take(pending);
          filled = 0;
        }
      }
    },
    finish: (): PictureTrack => ({
      size,
      luma,
      contrast,
      histDist,
      pixDiff,
      changed,
      back,
      motion,
    }),
  };
};

export const CAMERA_MOVES = [
  "static",
  "handheld",
  "pan left",
  "pan right",
  "tilt up",
  "tilt down",
  "push in",
  "pull out",
  "on the move",
  "fast motion",
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export const PICTURE_ISSUES = ["dark", "covered", "shaky"] as const;
export type PictureIssue = (typeof PICTURE_ISSUES)[number];

export interface PictureCut {
  /** Seconds into the clip of the first sample of the new shot. */
  readonly at: number;
  /** `jump` keeps the camera setup and colours: a jump cut or a punch-in. */
  readonly kind: "cut" | "jump";
}

export interface PictureSegment {
  readonly start: number;
  readonly end: number;
  readonly camera: CameraMove;
  readonly issues: ReadonlyArray<PictureIssue>;
}

export interface PictureAnalysis {
  readonly duration: number;
  readonly cuts: ReadonlyArray<PictureCut>;
  readonly segments: ReadonlyArray<PictureSegment>;
}

/** The readings below, in frame widths (or scale) per second and 0–255 luma. */
export const PICTURE_THRESHOLDS = {
  /** A pan or zoom must also outpace the sway around it. */
  pan: 0.25,
  zoom: 0.25,
  handheld: 0.05,
  /** Sway of a camera carried while walking. */
  onTheMove: 0.2,
  shaky: 0.6,
  dark: 32,
  coveredContrast: 7,
  coveredLuma: 90,
  /** A sample pair the one movement explains this little of is fast or chaotic motion. */
  minFit: 0.35,
};

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Each sample's median over its neighbours within `radius`, itself left out. */
const localMedian = (values: ReadonlyArray<number>, radius: number): Array<number> =>
  values.map((_, index) =>
    median([
      ...values.slice(Math.max(0, index - radius), index),
      ...values.slice(index + 1, index + 1 + radius),
    ]),
  );

/**
 * Samples that open a new shot. A hard cut changes most of the frame well above the motion
 * around it; a jump cut changes less, at once, between steady samples. A spike the picture
 * comes straight back from (a flash, a glitch) is neither.
 */
export const detectPictureCuts = (track: PictureTrack, rate = PICTURE_SAMPLE_RATE) => {
  const { histDist, pixDiff, changed, back } = track;
  const score = histDist.map((hist, i) => 0.6 * hist + 0.4 * Math.min(1, pixDiff[i]! * 4));
  const radius = Math.max(4, Math.round(rate * 0.5));
  const base = localMedian(score, radius);
  const changedBase = localMedian(changed, radius);
  const cuts: Array<PictureCut> = [];
  for (let i = 1; i < score.length; i++) {
    const s = score[i]!;
    const c = changed[i]!;
    const strong = s > 0.3 && s > base[i]! * 2.5 + 0.06 && c > 0.25;
    const relative = c > 0.45 && c > changedBase[i]! * 3 + 0.2 && s > base[i]! * 4 + 0.03;
    const side = (from: number, to: number, values: ReadonlyArray<number>) =>
      median(values.slice(Math.max(0, from), Math.max(0, to)));
    const jump =
      i >= 3 &&
      i + 3 <= score.length &&
      c >= 0.17 &&
      c >= 2.5 * (Math.max(side(i - 4, i, changed), side(i + 1, i + 5, changed)) + 0.02) &&
      pixDiff[i]! >= 2 * (Math.max(side(i - 4, i, pixDiff), side(i + 1, i + 5, pixDiff)) + 0.004) &&
      Math.max(changed[i - 1]!, changed[i + 1] ?? 0) <= 0.5 * c;
    if (!(strong || relative || jump)) continue;
    // A cut changes the picture between two samples; a whip pan or a flash is change spread
    // over several, or change the picture comes straight back from.
    const around = Math.max(changed[i - 1] ?? 0, changed[i + 1] ?? 0);
    if (around > 0.6 * c || back[i]! < 0.3) continue;
    const moved = track.motion[i];
    if (moved != null && moved.fit >= 0.5) continue;
    const previous = cuts.at(-1);
    // Two cuts a sample or two apart are one transition; the stronger stands.
    if (previous !== undefined && i - Math.round(previous.at * rate) < 3) continue;
    cuts.push({
      at: i / rate,
      kind: !strong && !relative && histDist[i]! < 0.4 && c < 0.5 ? "jump" : "cut",
    });
  }
  return cuts;
};

const sameIssues = (a: ReadonlyArray<PictureIssue>, b: ReadonlyArray<PictureIssue>) =>
  a.length === b.length && a.every((issue) => b.includes(issue));

/** What one stretch of a shot measured, before it is read as a camera move and issues. */
export interface WindowReading {
  /** First sample, and one past the last. */
  readonly start: number;
  readonly end: number;
  /** Frame widths per second, content movement (positive is right and down). */
  readonly speedX: number;
  readonly speedY: number;
  /** Scale change per second. */
  readonly zoom: number;
  /** Frame widths per second the movement wanders from its mean: sway and shake. */
  readonly jitter: number;
  /** Share of sample pairs one movement explains; low in fast or chaotic motion. */
  readonly steady: number;
  /** Share of sample pairs with enough texture to tell. */
  readonly textured: number;
  readonly luma: number;
  readonly contrast: number;
}

/** Length of the stretches a shot is read in, in seconds. */
export const PICTURE_WINDOW_SECONDS = 2;

/** Each shot read in stretches of `PICTURE_WINDOW_SECONDS`; the last of a shot may be shorter. */
export const pictureWindows = (
  track: PictureTrack,
  cuts: ReadonlyArray<PictureCut>,
  rate = PICTURE_SAMPLE_RATE,
): Array<WindowReading> => {
  const samples = track.luma.length;
  const step = Math.round(rate * PICTURE_WINDOW_SECONDS);
  const edges = [0, ...cuts.map((cut) => Math.round(cut.at * rate)), samples];
  const readings: Array<WindowReading> = [];
  const perSecond = rate / track.size.width;
  for (let shot = 0; shot + 1 < edges.length; shot++) {
    const from = edges[shot]!;
    const to = edges[shot + 1]!;
    for (let start = from; start < to; start += step) {
      // A short tail joins the stretch before it.
      const end = to - (start + step) < step / 2 ? to : start + step;
      // Motion from the sample before, so a stretch never measures across its shot's cut.
      const pairs: Array<GlobalMotion | null> = [];
      for (let i = Math.max(start, from + 1); i < end; i++) pairs.push(track.motion[i] ?? null);
      const textured = pairs.filter((pair) => pair !== null);
      const fitted = textured.filter((pair) => pair.fit >= PICTURE_THRESHOLDS.minFit);
      const mean = (pick: (pair: GlobalMotion) => number) =>
        fitted.length === 0 ? 0 : fitted.reduce((sum, pair) => sum + pick(pair), 0) / fitted.length;
      const dx = mean((pair) => pair.dx);
      const dy = mean((pair) => pair.dy);
      const jitter = Math.sqrt(mean((pair) => (pair.dx - dx) ** 2 + (pair.dy - dy) ** 2));
      readings.push({
        start,
        end,
        speedX: dx * perSecond,
        speedY: dy * perSecond,
        zoom: mean((pair) => pair.zoom) * rate,
        jitter: jitter * perSecond,
        steady: pairs.length === 0 ? 1 : fitted.length / pairs.length,
        textured: pairs.length === 0 ? 1 : textured.length / pairs.length,
        luma: median(track.luma.slice(start, end)),
        contrast: median(track.contrast.slice(start, end)),
      });
      if (end === to) break;
    }
  }
  return readings;
};

/** A stretch's camera move and issues. */
export const readWindow = (
  reading: WindowReading,
): { readonly camera: CameraMove; readonly issues: ReadonlyArray<PictureIssue> } => {
  const t = PICTURE_THRESHOLDS;
  const issues: Array<PictureIssue> = [];
  if (reading.contrast < t.coveredContrast && reading.luma < t.coveredLuma) issues.push("covered");
  else if (reading.luma < t.dark) issues.push("dark");
  if (reading.steady < 0.5 && reading.textured >= 0.5) {
    return { camera: "fast motion", issues };
  }
  if (reading.jitter > t.shaky) issues.push("shaky");
  const speed = Math.hypot(reading.speedX, reading.speedY);
  if (Math.abs(reading.zoom) > t.zoom && Math.abs(reading.zoom) > Math.max(speed, reading.jitter)) {
    return { camera: reading.zoom > 0 ? "push in" : "pull out", issues };
  }
  if (speed > t.pan && speed > reading.jitter) {
    // Content moving left means the camera turned right.
    const camera: CameraMove =
      Math.abs(reading.speedX) >= Math.abs(reading.speedY)
        ? reading.speedX < 0
          ? "pan right"
          : "pan left"
        : reading.speedY < 0
          ? "tilt down"
          : "tilt up";
    return { camera, issues };
  }
  const camera: CameraMove =
    reading.jitter > t.onTheMove
      ? "on the move"
      : reading.jitter > t.handheld
        ? "handheld"
        : "static";
  return { camera, issues };
};

/**
 * Reads a clip's track as cuts and segments: each stretch of a shot gets a camera move and its
 * issues, and neighbouring stretches that agree are joined.
 */
export const analysePicture = (
  track: PictureTrack,
  duration: number,
  rate = PICTURE_SAMPLE_RATE,
): PictureAnalysis => {
  const cuts = detectPictureCuts(track, rate);
  const shotStarts = new Set(cuts.map((cut) => Math.round(cut.at * rate)));
  const readings = pictureWindows(track, cuts, rate);
  const read = readings.map((reading) => ({ ...readWindow(reading) }));
  // One stretch between two that agree, in the same shot, is read as they are: a sway is not
  // a change of camera.
  for (let i = 1; i + 1 < read.length; i++) {
    const before = read[i - 1]!;
    const after = read[i + 1]!;
    if (
      before.camera === after.camera &&
      !shotStarts.has(readings[i]!.start) &&
      !shotStarts.has(readings[i + 1]!.start)
    ) {
      read[i] = { ...read[i]!, camera: before.camera };
    }
  }
  const segments: Array<PictureSegment> = [];
  for (const [index, reading] of readings.entries()) {
    const { camera, issues } = read[index]!;
    const last = segments.at(-1);
    if (
      last !== undefined &&
      !shotStarts.has(reading.start) &&
      last.camera === camera &&
      sameIssues(last.issues, issues)
    ) {
      segments[segments.length - 1] = { ...last, end: reading.end / rate };
    } else {
      segments.push({ start: reading.start / rate, end: reading.end / rate, camera, issues });
    }
  }
  const lastSegment = segments.at(-1);
  if (lastSegment !== undefined && duration > lastSegment.end) {
    segments[segments.length - 1] = { ...lastSegment, end: duration };
  }
  return { duration, cuts, segments };
};

const CONTACT_SHEET_TILES = { min: 6, even: 10, max: 16 };
const TILE_GAP_SECONDS = 0.75;

/**
 * Seconds to show on a clip's contact sheet: an even spread over the whole clip, so no stretch
 * goes unseen however long it is, then the middles of the segments in the biggest gaps left.
 */
export const contactSheetTimes = (analysis: PictureAnalysis): Array<number> => {
  const { duration } = analysis;
  if (duration <= 0) return [];
  const last = Math.max(0, duration - 0.1);
  const times: Array<number> = [];
  const gapTo = (seconds: number) =>
    Math.min(Number.POSITIVE_INFINITY, ...times.map((time) => Math.abs(time - seconds)));
  const even = Math.min(
    CONTACT_SHEET_TILES.even,
    Math.max(CONTACT_SHEET_TILES.min, Math.ceil(duration / 8)),
  );
  for (let i = 0; i < even; i++) {
    const seconds = Math.min(last, ((i + 0.5) / even) * duration);
    if (gapTo(seconds) >= TILE_GAP_SECONDS) times.push(seconds);
  }
  const middles = analysis.segments.map((segment) =>
    Math.min(last, (segment.start + segment.end) / 2),
  );
  while (times.length < CONTACT_SHEET_TILES.max) {
    const [best] = middles.toSorted((a, b) => gapTo(b) - gapTo(a));
    if (best === undefined || gapTo(best) < TILE_GAP_SECONDS) break;
    times.push(best);
  }
  return times.toSorted((a, b) => a - b);
};

/**
 * The ffmpeg filter that lays the chosen moments of a clip out in one image, each labelled with
 * its time when `labels` (an ffmpeg without drawtext makes the sheet bare).
 */
export const footageSheetFilter = (
  times: ReadonlyArray<number>,
  size: FrameSize,
  labels: boolean,
): string => {
  const portrait = size.height >= size.width;
  const columns = Math.min(times.length, portrait ? 8 : 4);
  const rows = Math.ceil(times.length / columns);
  // The first frame at or after each moment; `prev_t` is NaN on the first frame.
  const pick = times
    .map((seconds) => {
      const at = seconds.toFixed(3);
      return seconds <= 0 ? "eq(n,0)" : `gte(t,${at})*lt(prev_t,${at})`;
    })
    .join("+");
  return [
    `select='${pick}'`,
    `scale=${portrait ? 216 : 432}:-2`,
    ...(labels
      ? [
          `drawtext=text='%{pts\\:hms}':x=4:y=h-th-6:fontsize=14:fontcolor=white:box=1:boxborderw=3:boxcolor=black@0.65`,
        ]
      : []),
    `tile=${columns}x${rows}:padding=4:margin=4:color=0x111111`,
  ].join(",");
};

export const pictureClock = (seconds: number) => {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${(whole - minutes * 60).toFixed(1).padStart(4, "0")}`;
};

/** One line per segment, `m:ss.s-m:ss.s camera, issues`, then where the picture cuts. */
export const pictureLines = (analysis: PictureAnalysis): Array<string> => [
  ...analysis.segments.map(
    (segment) =>
      `${pictureClock(segment.start)}-${pictureClock(segment.end)} ${segment.camera}${segment.issues.length === 0 ? "" : `, ${segment.issues.join(", ")}`}`,
  ),
  ...(analysis.cuts.length === 0
    ? []
    : [
        `cuts at ${analysis.cuts.map((cut) => `${pictureClock(cut.at)}${cut.kind === "jump" ? " (jump)" : ""}`).join(", ")}`,
      ]),
];
