import { describe, expect, it } from "vite-plus/test";

import { applyEdits } from "./edits.ts";
import { footageStringout } from "./footage.ts";
import type { Timeline } from "./otio.ts";
import {
  passagePieces,
  soundPictureCommand,
  soundPictureLayout,
  soundPicturePassage,
} from "./soundPicture.ts";
import { linearTimeWarp } from "./speed.ts";
import { timelineWords } from "./words.ts";

// Two clips at 60 fps: a.MOV on frames 0-120, b.MOV on 120-180.
const stringout = footageStringout(
  [
    { target: "Footage/a.MOV", duration: 2, width: 1080, height: 1920 },
    { target: "Footage/b.MOV", duration: 1, width: 1080, height: 1920 },
  ],
  "/media",
);

const transcripts = new Map([
  [
    "Footage/a.MOV",
    [
      { w: "Hãy", start: 0.5, end: 0.6 },
      { w: "subscribe", start: 0.6, end: 1 },
      { w: "cho", start: 1, end: 1.5 },
      { w: "kênh", start: 1.5, end: 1.9 },
    ],
  ],
]);

const warped = (timeline: Timeline, name: string, speed: number): Timeline => ({
  ...timeline,
  tracks: {
    ...timeline.tracks,
    children: timeline.tracks.children.map((track) => ({
      ...track,
      children: track.children.map((child) =>
        child.OTIO_SCHEMA === "Clip.2" && child.name === name
          ? { ...child, effects: [linearTimeWarp(speed)] }
          : child,
      ),
    })),
  },
});

const sources = (timeline: Timeline, start: number, end: number) =>
  passagePieces(timeline, { start, end }, (target) => transcripts.has(target)).map(
    (piece) =>
      `${piece.startFrame}-${piece.endFrame} ${piece.target ?? "silence"} ${piece.sourceStart.toFixed(2)}-${piece.sourceEnd.toFixed(2)} x${piece.speed}`,
  );

describe("passagePieces", () => {
  it("maps timeline frames to source seconds across a clip join and past the end", () => {
    expect(sources(stringout, 60, 240)).toEqual([
      "60-120 Footage/a.MOV 1.00-2.00 x1",
      "120-180 Footage/b.MOV 0.00-1.00 x1",
      "180-240 silence 0.00-0.00 x1",
    ]);
  });

  it("joins the two sides of a cut, and keeps a split that plays straight on whole", () => {
    const cut = applyEdits(stringout, [{ kind: "removeRange", start: 36, end: 60, ripple: true }]);
    expect(sources(cut, 0, 96)).toEqual([
      "0-36 Footage/a.MOV 0.00-0.60 x1",
      "36-96 Footage/a.MOV 1.00-2.00 x1",
    ]);
    const split = applyEdits(stringout, [{ kind: "split", frame: 60 }]);
    expect(sources(split, 30, 90)).toEqual(["30-90 Footage/a.MOV 0.50-1.50 x1"]);
  });

  it("follows a clip's speed and direction into its source", () => {
    // At double speed the clip's 120 frames play 4 source seconds; frames 30-60 play 1-2 s.
    expect(sources(warped(stringout, "a.MOV", 2), 30, 60)).toEqual([
      "30-60 Footage/a.MOV 1.00-2.00 x2",
    ]);
    // Backwards, the clip starts at its media's end: frames 0-30 play 2 s down to 1.5 s.
    expect(sources(warped(stringout, "a.MOV", -1), 0, 30)).toEqual([
      "0-30 Footage/a.MOV 1.50-2.00 x-1",
    ]);
  });

  it("hears the clip with a transcript when two tracks play at once", () => {
    const music = footageStringout(
      [{ target: "Audio/music.wav", duration: 3, width: 1080, height: 1920 }],
      "/media",
    );
    const audio = (timeline: Timeline) =>
      timeline.tracks.children.filter((track) => track.kind === "Audio");
    const layered: Timeline = {
      ...stringout,
      tracks: {
        ...stringout.tracks,
        children: [...audio(music), ...stringout.tracks.children],
      },
    };
    expect(sources(layered, 90, 150)).toEqual([
      "90-120 Footage/a.MOV 1.50-2.00 x1",
      "120-150 Audio/music.wav 2.00-2.50 x1",
    ]);
  });
});

describe("soundPicturePassage", () => {
  const view = timelineWords(stringout, transcripts);

  it("pictures words with room either side, and a cut alone with more", () => {
    // Words 2-3 are frames 36-90; half a second (30 frames) either side.
    expect(soundPicturePassage(view, 180, { fromWord: 2, toWord: 3 })).toEqual({
      range: { start: 6, end: 120 },
      cut: null,
    });
    // A cut of word 3 (frames 60-90) is shown with 1.5 s either side, inside the timeline.
    expect(soundPicturePassage(view, 180, { cutFromWord: 3 })).toEqual({
      range: { start: 0, end: 180 },
      cut: { start: 60, end: 90 },
    });
    expect(
      soundPicturePassage(view, 180, { start: 30, end: 100, cutStart: 90, cutEnd: 130 }),
    ).toEqual({ range: { start: 30, end: 100 }, cut: { start: 90, end: 100 } });
  });

  it("says why a passage can't be pictured", () => {
    const refused = (request: Parameters<typeof soundPicturePassage>[2], duration = 180) =>
      soundPicturePassage(view, duration, request);
    expect(refused({})).toMatch(/say what to picture/);
    expect(refused({ fromWord: 9 })).toMatch(/no word 9/);
    expect(refused({ start: 10 })).toMatch(/both a start and an end/);
    expect(refused({ start: 0, end: 1200 }, 1200)).toMatch(
      /at most 15 seconds \(900 frames here\)/,
    );
    expect(refused({ start: 0, end: 30, cutFromWord: 3 })).toMatch(/outside the passage/);
    expect(refused({ start: 60, end: 90, cutFromWord: 3 })).toMatch(/whole passage/);
  });
});

describe("soundPictureLayout", () => {
  const range = { start: 0, end: 160 };
  const cut = { start: 36, end: 60 };
  const after = applyEdits(stringout, [{ kind: "removeRange", ...cut, ripple: true }]);
  const kept = { start: 0, end: 136 };
  const spoken = (target: string) => transcripts.has(target);
  const words = (timeline: Timeline) =>
    timelineWords(timeline, transcripts).clips.flatMap((clip) => clip.words ?? []);
  const layout = soundPictureLayout(60, [
    {
      title: "Now",
      range,
      pieces: passagePieces(stringout, range, spoken),
      words: words(stringout),
      shaded: [cut],
    },
    {
      title: "Cut",
      range: kept,
      pieces: passagePieces(after, kept, spoken),
      words: words(after),
      cuts: [cut.start],
    },
  ]);
  const [now, cutRow] = layout.rows;

  it("draws both rows at one scale, the cut row shorter by what came out", () => {
    expect(layout.pixelsPerFrame).toBe(8);
    expect([now?.width, cutRow?.width]).toEqual([1280, 1088]);
    expect(now?.shaded).toEqual([{ x: 288, width: 192 }]);
    // The clip join moves left with the cut, and the cut's own join is the red one.
    expect(now?.joins).toEqual([{ x: 960, cut: false }]);
    expect(cutRow?.joins).toEqual([
      { x: 288, cut: true },
      { x: 768, cut: false },
    ]);
    expect(now?.ticks.map((tick) => tick.frame)).toEqual([
      0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150,
    ]);
  });

  it("places each word at its frame, on a second line or unlabelled when crowded", () => {
    expect(now?.words).toEqual([
      { x: 240, lane: 0, text: "1 Hãy" },
      { x: 288, lane: 0, text: "2 subscribe" },
      { x: 480, lane: 0, text: "3 cho" },
      { x: 720, lane: 0, text: "4 kênh" },
    ]);
    // After the cut "subscribe" is gone and the rest are renumbered where they now play.
    expect(cutRow?.words.map((word) => `${word.text}@${word.x}`)).toEqual([
      "1 Hãy@240",
      "2 cho@288",
      "3 kênh@528",
    ]);
    const crowded = soundPictureLayout(60, [
      {
        title: "Now",
        range: { start: 0, end: 900 },
        pieces: [],
        words: [10, 12, 14].map((startFrame, index) => ({
          index: index + 1,
          word: "word",
          startFrame,
          endFrame: startFrame + 2,
        })),
      },
    ]);
    expect(crowded.rows[0]?.words.map((word) => word.lane)).toEqual([0, 1, null]);
  });

  it("decodes each piece from its source at its speed, and silence where nothing plays", () => {
    const fast = warped(warped(stringout, "a.MOV", 2), "b.MOV", -0.25);
    const passage = { start: 90, end: 240 };
    const drawn = soundPictureLayout(60, [
      {
        title: "It's 50%: [x]",
        range: passage,
        pieces: passagePieces(fast, passage, spoken),
        words: [],
      },
    ]);
    const files = new Map([["Footage/a.MOV", "/media/Footage/a.MOV"]]);
    const { inputs, graph } = soundPictureCommand(drawn, (target) => files.get(target) ?? null, {
      fontFile: "/fonts/Arial.ttf",
    });
    // b.MOV has no sound to decode, so only a.MOV is an input: source 3-4 s for frames 90-120.
    expect(inputs).toEqual(["-ss", "3.00000", "-t", "1.00000", "-i", "/media/Footage/a.MOV"]);
    expect(graph).toContain("[0:a:0]aresample=16000");
    expect(graph).toContain("atempo=2.000000,apad,atrim=end=0.50000");
    expect(graph).toContain("anullsrc=r=16000:cl=mono,atrim=end=1.00000[r0p1]");
    expect(graph).toContain("[r0p0][r0p1][r0p2]concat=n=3:v=0:a=1,asplit=2");
    // Title punctuation that would end the drawtext option is taken out.
    expect(graph).toContain("drawtext=fontfile=/fonts/Arial.ttf:expansion=none:text='It’s 50 x'");
    expect(soundPictureCommand(drawn, () => null, null).graph).not.toContain("drawtext");

    const slow = passagePieces(fast, { start: 120, end: 180 }, spoken);
    const backwards = soundPictureCommand(
      soundPictureLayout(60, [
        { title: "", range: { start: 120, end: 180 }, pieces: slow, words: [] },
      ]),
      () => "/b.MOV",
      null,
    );
    expect(backwards.graph).toContain("areverse,atempo=0.5,atempo=0.500000,apad");
  });
});
