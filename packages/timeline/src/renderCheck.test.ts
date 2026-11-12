import { describe, expect, it } from "vite-plus/test";

import { type Clip, type Gap, rationalTime, type Timeline, timeRange, type Track } from "./otio.ts";
import {
  compareRender,
  CONTACT_SHEET_MAX_TILES,
  contactSheetFilter,
  contactSheetTiles,
  detectCuts,
  detectFlashes,
  type ExportAnalysis,
  type ExportProbe,
  parseAudioAnalysis,
  parseExportProbe,
  parseVideoAnalysis,
  type RenderCheckItem,
  timelineRenderFacts,
} from "./renderCheck.ts";
import { linearTimeWarp } from "./speed.ts";

const RATE = 30;

const clip = (name: string, sourceStart: number, frames: number, url = `${name}.mov`): Clip => ({
  OTIO_SCHEMA: "Clip.2",
  name,
  source_range: timeRange(sourceStart, frames, RATE),
  media_references: {
    DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: url, metadata: {} },
  },
  active_media_reference_key: "DEFAULT_MEDIA",
  enabled: true,
  metadata: {},
});

const gap = (frames: number): Gap => ({
  OTIO_SCHEMA: "Gap.1",
  name: "",
  source_range: timeRange(0, frames, RATE),
  enabled: true,
  metadata: {},
});

const track = (
  name: string,
  kind: Track["kind"],
  children: Track["children"],
  metadata: Track["metadata"] = {},
): Track => ({ OTIO_SCHEMA: "Track.1", name, kind, children, enabled: true, metadata });

const timelineOf = (...tracks: ReadonlyArray<Track>): Timeline => ({
  OTIO_SCHEMA: "Timeline.1",
  name: "Short",
  global_start_time: rationalTime(0, RATE),
  tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", enabled: true, metadata: {}, children: tracks },
  metadata: { stellar: { frame: { width: 1080, height: 1920 } } },
});

/**
 * The cut the generated test export was made from, 12 s at 30 fps:
 * a 0-60, b 60-120, a gap 120-150, c 150-270 (razored at 210, nothing removed), a still 270-360.
 */
const cut = timelineOf(
  track("V1", "Video", [
    clip("a", 0, 60),
    clip("b", 0, 60),
    gap(30),
    clip("c", 0, 60),
    clip("c", 60, 60),
    clip("card", 0, 90, "card.png"),
  ]),
  track("A1", "Audio", [clip("vo", 0, 360, "vo.wav")]),
);

const probe: ExportProbe = {
  width: 1080,
  height: 1920,
  fps: RATE,
  duration: 12,
  videoCodec: "h264",
  audioCodec: "aac",
};

/** Frame differences of an export with gentle motion and a cut at each frame named. */
const diffsWith = (cuts: ReadonlyArray<number>, frames = 360): Array<number> =>
  Array.from({ length: frames }, (_, frame) => (cuts.includes(frame) ? 80 : 2));

const clean: ExportAnalysis = {
  black: [{ start: 4, end: 5 }],
  frozen: [
    { start: 4, end: 5 },
    { start: 9, end: 12 },
  ],
  diffs: diffsWith([60, 120, 150, 270]),
  silence: [],
  loudness: -14.3,
  truePeak: -1.4,
};

const levels = (items: ReadonlyArray<RenderCheckItem>) =>
  Object.fromEntries(items.map((item) => [item.id, item.level]));
const detailOf = (items: ReadonlyArray<RenderCheckItem>, id: RenderCheckItem["id"]) =>
  items.find((item) => item.id === id)?.detail;

describe("timelineRenderFacts", () => {
  it("separates cuts that must show from jump cuts, razor cuts and dissolves", () => {
    const facts = timelineRenderFacts(
      timelineOf(
        track(
          "V1",
          "Video",
          [
            clip("a", 0, 30),
            // Same file, 20 frames later: a jump cut.
            clip("a", 50, 30),
            // Same file, carrying straight on: a razor cut that removed nothing.
            clip("a", 80, 30),
            clip("b", 0, 30),
            clip("c", 0, 30),
            // One clip at double speed, razored: the second piece starts where the first got to.
            { ...clip("d", 0, 30), effects: [linearTimeWarp(2)] },
            { ...clip("d", 60, 30), effects: [linearTimeWarp(2)] },
          ],
          {
            premiere: { transitions: [{ name: "Cross Dissolve", startFrame: 115, endFrame: 125 }] },
          },
        ),
        // B-roll over the middle hides what happens under it and is itself a cut in and out.
        track("V2", "Video", [gap(40), clip("broll", 0, 30)]),
        // An emoji coming and going is not a cut.
        // Nor is a camera raw photo, which the preview draws from a rendition.
        track("V3", "Video", [
          gap(10),
          clip("emoji", 0, 10, "emoji.png"),
          clip("photo", 0, 10, "photo.dng"),
        ]),
        // Captions change with the words, not with the picture.
        track("C1", "Video", [gap(20), clip("a caption", 0, 25, ""), clip("the next", 0, 25, "")], {
          stellar: { captions: true },
        }),
      ),
    );
    expect(facts.cuts).toEqual([
      { frame: 30, hard: false },
      { frame: 40, hard: true },
      { frame: 70, hard: true },
      { frame: 90, hard: true },
      { frame: 120, hard: false },
      { frame: 150, hard: true },
    ]);
  });

  it("finds where black, a held picture and silence are the timeline's own doing", () => {
    const facts = timelineRenderFacts(cut);
    expect(facts.gaps).toEqual([{ start: 120, end: 150 }]);
    expect(facts.holds).toEqual([
      { start: 120, end: 150 },
      { start: 270, end: 360 },
      { start: 270, end: 360 },
    ]);
    expect(facts.silent).toEqual([]);
    expect(facts.frame).toEqual({ width: 1080, height: 1920 });
    expect(facts.cuts.map((entry) => entry.frame)).toEqual([60, 120, 150, 270]);

    const muted = timelineRenderFacts(
      timelineOf(
        track("V1", "Video", [clip("a", 0, 60), { ...clip("b", 0, 2), enabled: false }]),
        track("A1", "Audio", [clip("vo", 0, 20, "vo.wav"), gap(30), clip("vo", 50, 12, "vo.wav")]),
        track("C1", "Video", [gap(60), clip("a caption", 0, 2, "")], {
          stellar: { captions: true },
        }),
      ),
    );
    expect(muted.silent).toEqual([{ start: 20, end: 50 }]);
    // A disabled clip draws nothing, so it is neither picture nor a sliver; nor is a caption.
    expect(muted.gaps).toEqual([{ start: 60, end: 62 }]);
    expect(muted.slivers).toEqual([]);
  });
});

describe("reading what the tools print", () => {
  it("reads ffprobe's streams, taking the picture's own length", () => {
    expect(
      parseExportProbe({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1080,
            height: 1920,
            r_frame_rate: "60000/1001",
            avg_frame_rate: "60000/1001",
            duration: "31.998633",
          },
          { codec_type: "audio", codec_name: "aac", duration: "32.021333" },
        ],
        format: { duration: "32.021333" },
      }),
    ).toEqual({
      width: 1080,
      height: 1920,
      fps: 60000 / 1001,
      duration: 31.998633,
      videoCodec: "h264",
      audioCodec: "aac",
    });
    expect(parseExportProbe({ streams: [{ codec_type: "audio", codec_name: "aac" }] })).toBeNull();
  });

  it("reads black, frozen spans and frame differences from the picture pass", () => {
    // As ffmpeg 7.1 prints them: each filter writes its own frame header, out of time order.
    const printed = [
      "frame:0    pts:512     pts_time:0.0333333",
      "lavfi.signalstats.YAVG=2.18451",
      "frame:1    pts:1024    pts_time:0.0666667",
      "lavfi.signalstats.YAVG=75.2046",
      "frame:120  pts:61440   pts_time:4",
      "lavfi.freezedetect.freeze_end=4",
      "frame:90   pts:46080   pts_time:3",
      "lavfi.freezedetect.freeze_start=2",
      "frame:150  pts:76800   pts_time:5",
      "lavfi.black_end=5",
      "frame:120  pts:61440   pts_time:4",
      "lavfi.black_start=4",
      // A freeze still running when the file ends has no end mark.
      "frame:300  pts:153600  pts_time:10",
      "lavfi.freezedetect.freeze_start=9",
    ].join("\n");
    expect(parseVideoAnalysis(printed, { fps: 30, duration: 12 })).toEqual({
      black: [{ start: 4, end: 5 }],
      frozen: [
        { start: 2, end: 4 },
        { start: 9, end: 12 },
      ],
      diffs: [0, 2.18451, 75.2046],
    });
    expect(parseVideoAnalysis("", { fps: 30, duration: 12 }).diffs).toBeNull();
  });

  it("reads silences, loudness and the highest true peak from the sound pass", () => {
    const printed = [
      "frame:357  pts:365568  pts_time:7.616",
      "lavfi.silence_end=7.616",
      "frame:328  pts:335872  pts_time:6.997333",
      "lavfi.silence_start=6.016",
      "frame:0    pts:4800    pts_time:0.1",
      "lavfi.r128.I=-70.000",
      "frame:0    pts:4800    pts_time:0.1",
      "lavfi.r128.true_peak=0.891",
      "frame:119  pts:571200  pts_time:11.9",
      "lavfi.r128.I=-13.600",
      "frame:119  pts:571200  pts_time:11.9",
      "lavfi.r128.true_peak=0.5",
    ].join("\n");
    const audio = parseAudioAnalysis(printed, 12);
    expect(audio.silence).toEqual([{ start: 6.016, end: 7.616 }]);
    expect(audio.loudness).toBe(-13.6);
    expect(audio.truePeak).toBeCloseTo(-1.0, 1);
    expect(parseAudioAnalysis("lavfi.r128.I=-70.000", 12)).toEqual({
      silence: [],
      loudness: null,
      truePeak: null,
    });
  });
});

describe("finding cuts in frame differences", () => {
  it("finds a cut against its surroundings, not against a fixed level", () => {
    // A whip pan is a run of big differences; no frame in it stands out from its neighbours.
    const pan = Array.from({ length: 60 }, (_, frame) => (frame >= 20 && frame < 32 ? 30 : 2));
    expect(detectCuts(pan)).toEqual([]);
    // 30 fps footage on a 60 fps timeline repeats every frame, so every other difference is 0.
    const doubled = Array.from({ length: 60 }, (_, frame) => (frame % 2 === 0 ? 14 : 0));
    expect(detectCuts(doubled)).toEqual([]);
    const jumpCut = Array.from({ length: 60 }, (_, frame) => (frame === 30 ? 12 : 1.5));
    expect(detectCuts(jumpCut)).toEqual([30]);
  });

  it("calls one or two frame shots flashes, and longer ones shots", () => {
    expect(detectFlashes(diffsWith([100, 101, 200, 202, 300, 303]))).toEqual([
      { frame: 100, frames: 1 },
      { frame: 200, frames: 2 },
    ]);
  });
});

describe("compareRender", () => {
  it("passes an export that is the timeline, with the timeline's gap as the one note", () => {
    const items = compareRender(timelineRenderFacts(cut), probe, clean);
    expect(levels(items)).toEqual({
      resolution: "pass",
      frameRate: "pass",
      duration: "pass",
      codecs: "pass",
      audio: "pass",
      black: "warn",
      frozen: "pass",
      silence: "pass",
      loudness: "pass",
      truePeak: "pass",
      cuts: "pass",
      flashFrames: "pass",
    });
    expect(detailOf(items, "black")).toBe(
      "Black where the timeline has a gap: 1.00 s at 0:04.00 (frame 120).",
    );
  });

  it("fails an export whose container doesn't match the sequence", () => {
    const items = compareRender(
      timelineRenderFacts(cut),
      { ...probe, width: 1920, height: 1080, fps: 29.97, duration: 12.1, audioCodec: null },
      { ...clean, silence: [], loudness: null, truePeak: null },
    );
    expect(levels(items)).toMatchObject({
      resolution: "fail",
      frameRate: "fail",
      duration: "fail",
      audio: "fail",
    });
    expect(detailOf(items, "duration")).toBe(
      "The export is 12.1 s, 3 frames longer than the timeline (12.0 s).",
    );
    // Nothing is said about loudness or silence in a file with no sound.
    expect(items.some((item) => item.id === "loudness" || item.id === "silence")).toBe(false);
  });

  it("allows one frame of length either way and a master codec with a note", () => {
    const items = compareRender(
      timelineRenderFacts(cut),
      { ...probe, duration: 12 + 1 / RATE, videoCodec: "prores", audioCodec: "pcm_s24le" },
      clean,
    );
    expect(levels(items)).toMatchObject({ duration: "pass", codecs: "warn" });
  });

  it("reports black, a frozen picture and silence the timeline doesn't explain", () => {
    const items = compareRender(timelineRenderFacts(cut), probe, {
      ...clean,
      black: [
        { start: 4, end: 5 },
        { start: 1, end: 1.2 },
      ],
      frozen: [...clean.frozen, { start: 6, end: 7.8 }],
      silence: [{ start: 6.016, end: 7.616 }],
      loudness: -22,
      truePeak: -0.2,
    });
    expect(levels(items)).toMatchObject({
      black: "fail",
      frozen: "warn",
      silence: "warn",
      loudness: "warn",
      truePeak: "warn",
    });
    expect(detailOf(items, "black")).toBe(
      "Black the timeline doesn't explain: 0.20 s at 0:01.00 (frame 30).",
    );
    expect(detailOf(items, "frozen")).toContain("1.80 s at 0:06.00 (frame 180)");
    expect(detailOf(items, "loudness")).toBe(
      "-22.0 LUFS, 8.0 LU quieter than the -14 LUFS short-form target.",
    );
  });

  it("finds a timeline cut one frame off and reports one that isn't there", () => {
    const facts = timelineRenderFacts(cut);
    const late = compareRender(facts, probe, { ...clean, diffs: diffsWith([61, 120, 150, 269]) });
    expect(levels(late).cuts).toBe("pass");
    const missing = compareRender(facts, probe, { ...clean, diffs: diffsWith([60, 120, 150]) });
    expect(levels(missing).cuts).toBe("warn");
    expect(detailOf(missing, "cuts")).toBe(
      "1 of 4 cuts don't show within 1 frame of the timeline: 0:09.00 (frame 270).",
    );
    // Most cuts somewhere else: this file was exported from another version of the cut.
    const other = compareRender(facts, probe, { ...clean, diffs: diffsWith([45, 120, 170, 290]) });
    expect(levels(other).cuts).toBe("fail");
  });

  it("matches cuts by time when the export runs at another frame rate", () => {
    const facts = timelineRenderFacts(cut);
    const items = compareRender(
      facts,
      { ...probe, fps: 60 },
      { ...clean, diffs: diffsWith([120, 240, 300, 540], 720) },
    );
    expect(levels(items)).toMatchObject({ frameRate: "fail", cuts: "pass" });
  });

  it("tells a leftover sliver on the timeline from a flash the timeline doesn't have", () => {
    const stray = compareRender(timelineRenderFacts(cut), probe, {
      ...clean,
      diffs: diffsWith([60, 120, 150, 210, 211, 270]),
    });
    expect(levels(stray).flashFrames).toBe("warn");
    expect(detailOf(stray, "flashFrames")).toBe(
      "Shots of one or two frames the timeline doesn't have: 1-frame flash at 0:07.00 (frame 210).",
    );

    const withSliver = timelineRenderFacts(
      timelineOf(
        track("V1", "Video", [clip("a", 0, 100), clip("b", 0, 2), clip("c", 0, 100)]),
        track("A1", "Audio", [clip("vo", 0, 202, "vo.wav")]),
      ),
    );
    const sliver = compareRender(
      withSliver,
      { ...probe, duration: 202 / RATE },
      { ...clean, black: [], frozen: [], diffs: diffsWith([100, 102], 202) },
    );
    expect(levels(sliver)).toMatchObject({ cuts: "pass", flashFrames: "fail" });
    expect(detailOf(sliver, "flashFrames")).toBe(
      "Leftover slivers flash on screen: V1 b is 2 frames long at 0:03.33 (frame 100).",
    );
  });
});

describe("the contact sheet", () => {
  it("shows an even spread, the frame after each cut, and flashes", () => {
    const tiles = contactSheetTiles(timelineRenderFacts(cut), probe, [{ frame: 210 }]);
    expect(tiles.filter((tile) => tile.kind === "cut").map((tile) => tile.frame)).toEqual([
      61, 121, 151, 271,
    ]);
    expect(tiles.filter((tile) => tile.kind === "flash").map((tile) => tile.frame)).toEqual([210]);
    expect(tiles.filter((tile) => tile.kind === "even")).toHaveLength(12);
    expect(tiles.map((tile) => tile.frame)).toEqual(
      tiles.map((tile) => tile.frame).toSorted((a, b) => a - b),
    );
  });

  it("thins the cuts of a busy timeline to fit the sheet", () => {
    const busy = {
      rate: RATE,
      cuts: Array.from({ length: 150 }, (_, index) => ({ frame: (index + 1) * 20, hard: true })),
    };
    const tiles = contactSheetTiles(busy, { fps: RATE, duration: 151 * (20 / RATE) });
    expect(tiles.length).toBeLessThanOrEqual(CONTACT_SHEET_MAX_TILES);
    expect(tiles.filter((tile) => tile.kind === "cut").length).toBeGreaterThan(30);
  });

  it("selects the tiles by frame and labels each with its own frame and time", () => {
    const filter = contactSheetFilter(
      [
        { frame: 15, seconds: 0.5, kind: "even" },
        { frame: 61, seconds: 61 / 30, kind: "cut" },
      ],
      probe,
      true,
    );
    expect(filter).toContain("select='eq(n,15)+eq(n,61)'");
    expect(filter).toContain("text='CUT'");
    expect(filter).toContain("enable='between(t,2.01667,2.05000)'");
    expect(filter).not.toContain("FLASH");
    expect(filter.endsWith("tile=2x1:padding=4:margin=4:color=0x111111")).toBe(true);
    expect(contactSheetFilter([{ frame: 15, seconds: 0.5, kind: "even" }], probe, false)).toBe(
      "select='eq(n,15)',scale=216:-2,tile=1x1:padding=4:margin=4:color=0x111111",
    );
  });
});
