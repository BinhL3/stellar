import { describe, expect, it } from "vite-plus/test";

import { applyEdits } from "./edits.ts";
import { footageStringout } from "./footage.ts";
import {
  auditJoins,
  clippedEdgeReason,
  clippedEdges,
  joinAuditText,
  placePauseCut,
  placeWordCut,
} from "./joins.ts";
import { type AudioLevels, levelsOf } from "./levels.ts";
import type { Timeline } from "./otio.ts";
import { linearTimeWarp } from "./speed.ts";
import { timelineWords, type TranscriptWord, wordsText } from "./words.ts";

const TARGET = "Footage/a.MOV";
// One four-second clip at 60 fps on frames 0-240.
const stringout = footageStringout(
  [{ target: TARGET, duration: 4, width: 1080, height: 1920 }],
  "/media",
);

/** Levels at 10 ms: speech at -20 dBFS wherever `loud` covers, room tone at -60 elsewhere. */
const measured = (loud: ReadonlyArray<readonly [number, number]>): Map<string, AudioLevels> =>
  new Map([
    [
      TARGET,
      levelsOf(
        Array.from({ length: 400 }, (_, i) =>
          loud.some(([from, to]) => i >= Math.round(from * 100) && i < Math.round(to * 100))
            ? -20
            : -60,
        ),
        0.01,
      ),
    ],
  ]);

// As an aligner times them: "um" is given 60 ms of quiet before its sound starts, "um" and "we"
// leave only a 30 ms dip between them at 1.44 s, and "we go" is said in one breath.
const said: ReadonlyArray<TranscriptWord> = [
  { w: "So", start: 0.5, end: 0.8 },
  { w: "um", start: 1, end: 1.3 },
  { w: "we", start: 1.5, end: 1.8 },
  { w: "go", start: 1.8, end: 2.1 },
  { w: "now", start: 3.3, end: 3.6 },
];
const transcripts = new Map([[TARGET, said]]);
const sound: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.8],
  [1.06, 1.44],
  [1.47, 2.1],
  [3.3, 3.6],
];
const levels = measured(sound);
const view = timelineWords(stringout, transcripts);

const atSpeed = (speed: number): Timeline => ({
  ...stringout,
  tracks: {
    ...stringout.tracks,
    children: stringout.tracks.children.map((track) => ({
      ...track,
      children: track.children.map((child) =>
        child.OTIO_SCHEMA === "Clip.2" ? { ...child, effects: [linearTimeWarp(speed)] } : child,
      ),
    })),
  },
});

describe("placeWordCut", () => {
  it("moves an edge that word timings put in sound onto the dip between the words", () => {
    // By timings "um" ends at frame 90, where "we" is already sounding; the dip is at 87.
    expect(placeWordCut(view, levels, 2, 2)).toMatchObject({
      start: 60,
      end: 87,
      note: "word 2: frames 60-87, start at -60 dBFS, end moved 0.05s earlier to -60 dBFS",
    });
  });

  it("says so when the words run together and no frame between them is quiet", () => {
    const cut = placeWordCut(view, levels, 3, 3);
    expect(cut).toMatchObject({ start: 87, end: 108 });
    expect(typeof cut === "string" ? cut : cut.note).toBe(
      'word 3: frames 87-108, start moved 0.05s earlier to -60 dBFS, end at -20 dBFS (no quiet between "we" and "go": speech sits at -20 dBFS, so this join may be heard)',
    );
  });

  it("keeps the word timings, and says it did, for a clip with no levels", () => {
    expect(placeWordCut(view, new Map(), 2, 2)).toMatchObject({
      start: 60,
      end: 90,
      note: "word 2: frames 60-90, start not measured, end not measured",
    });
    expect(placeWordCut(view, levels, 4, 9)).toBe("no word 9 (the timeline has 5 words)");
  });
});

describe("placePauseCut", () => {
  it("trims the measured quiet after a word down to what is left, most of it after the word", () => {
    // 1.2 s of quiet from 2.10 s: 0.15 s stays after "go" and 0.10 s before "now".
    expect(placePauseCut(view, levels, 4)).toMatchObject({
      start: 135,
      end: 192,
      note: "the pause after 4:go: 1.20s of quiet (at most -60 dBFS), removed frames 135-192, 0.25s left",
    });
    expect(placePauseCut(view, levels, 4, 0.6)).toMatchObject({ start: 148, end: 183 });
    expect(placePauseCut(view, levels, 4, 2)).toEqual({
      nothing: "the pause after 4:go: 1.20s of quiet, already about 2.00s; nothing removed",
    });
  });

  it("places the trim in a sped-up clip's own frames", () => {
    // At double speed the 1.2 s of source quiet is heard for 0.6 s, from frame 63.
    const fast = timelineWords(atSpeed(2), transcripts);
    expect(placePauseCut(fast, levels, 4)).toMatchObject({
      start: 72,
      end: 93,
      note: "the pause after 4:go: 0.60s of quiet (at most -60 dBFS), removed frames 72-93, 0.25s left",
    });
  });

  it("refuses a pause that holds sound no word explains, or that can't be measured", () => {
    const withBurst = measured([...sound, [2.5, 2.8]]);
    expect(placePauseCut(view, withBurst, 4)).toBe(
      "the pause after 4:go holds 0.30s of sound at speaking level that no word explains (frames 150-168), so it is not only a pause. Decide what that sound is, then cut with removeRange or leave it",
    );
    expect(placePauseCut(view, new Map(), 4)).toBe(
      "the pause after 4:go can't be measured: a.MOV has no audio levels. Use removeRange",
    );
    expect(placePauseCut(view, levels, 5)).toContain("word 5 is the last in its clip");
  });
});

describe("clippedEdges", () => {
  const clipped = (edits: Parameters<typeof applyEdits>[1], using = levels) =>
    clippedEdges(
      view,
      timelineWords(applyEdits(stringout, edits), transcripts),
      transcripts,
      using,
      [],
    );

  it("finds a new clip edge inside a word that is sounding there, whichever edit made it", () => {
    // Frame 72 is 1.2 s, in the middle of "um".
    const [byTrim] = clipped([{ kind: "trim", clipId: "1:0", edge: "end", frame: 72 }]);
    expect(byTrim).toMatchObject({
      side: "end",
      word: "um",
      wordIndex: 2,
      db: -20,
      quiet: { frames: -9, db: -60 },
    });
    expect(byTrim === undefined ? "" : clippedEdgeReason(byTrim, 60)).toBe(
      'it would end #1:0 (a.MOV, A1) inside word 2 "um" while it sounds: -20 dBFS at the edge, where this recording\'s speech sits at -20 and its room tone at -60. The nearest quiet is 9 frames (0.15s earlier) at -60 dBFS. Cut by word instead (removeWords, or trimPause with afterWord), which puts the edge on measured quiet, or move the edge to the quiet point',
    );
    expect(
      clipped([{ kind: "removeRange", start: 72, end: 150, ripple: true }]).map(
        (edge) => `${edge.side} ${edge.word}`,
      ),
    ).toEqual(["end um"]);
    // A split plays straight through, so it is no edge until one of its pieces goes.
    expect(clipped([{ kind: "split", frame: 72 }])).toEqual([]);
    expect(
      clipped([
        { kind: "split", frame: 72 },
        { kind: "delete", clipId: "1:0~72" },
      ]).map((edge) => `${edge.side} ${edge.word}`),
    ).toEqual(["end um"]);
  });

  it("passes edges on quiet, edges a word cut placed, and clips it can't judge", () => {
    // 1.05 s is inside "um" by its timing but the recording is still quiet there.
    expect(clipped([{ kind: "trim", clipId: "1:0", edge: "end", frame: 63 }])).toEqual([]);
    expect(clipped([{ kind: "trim", clipId: "1:0", edge: "end", frame: 72 }], new Map())).toEqual(
      [],
    );
    const cut = placeWordCut(view, levels, 3, 3);
    if (typeof cut === "string") throw new Error(cut);
    const after = applyEdits(stringout, [{ kind: "removeRange", ...cut, ripple: true }]);
    const afterView = timelineWords(after, transcripts);
    // Its end is at speaking level between "we" and "go", where Stellar itself put it.
    expect(clippedEdges(view, afterView, transcripts, levels, cut.edges)).toEqual([]);
    // An edge that was already there is not this edit's doing.
    const bad = applyEdits(stringout, [{ kind: "trim", clipId: "1:0", edge: "end", frame: 72 }]);
    expect(
      clippedEdges(
        timelineWords(bad, transcripts),
        timelineWords(
          applyEdits(bad, [{ kind: "move", clipId: "1:0", toTrack: "A1", startFrame: 30 }]),
          transcripts,
        ),
        transcripts,
        levels,
        [],
      ),
    ).toEqual([]);
  });
});

describe("auditJoins", () => {
  it("reads a join as heard: the words either side, the level at each edge, a clipped word", () => {
    const cut = applyEdits(stringout, [{ kind: "removeRange", start: 72, end: 108, ripple: true }]);
    const cutView = timelineWords(cut, transcripts);
    const audit = auditJoins(cutView, transcripts, levels);
    expect(audit).toMatchObject({ joins: 1, flagged: 1, pauses: 1, unread: 0 });
    expect(joinAuditText(cutView, audit).split("\n").slice(3)).toEqual([
      'J A1 @72 (1.20s) #1:0|#1:0~108: 1:So 2:um [-20 dBFS] | [-20 dBFS] 3:go 4:now · clips "um" at its end · incoming edge at speaking level',
      "P A1 @90 (1.50s) after 3:go (1.20s quiet)",
    ]);
  });

  it("flags words said twice across a join, and a join left on quiet is ok", () => {
    const restart: ReadonlyArray<TranscriptWord> = [
      { w: "I", start: 0.2, end: 0.4 },
      { w: "think", start: 0.5, end: 0.8 },
      { w: "I", start: 1.5, end: 1.7 },
      { w: "think", start: 1.8, end: 2.1 },
      { w: "so.", start: 2.2, end: 2.5 },
    ];
    const heard = new Map([[TARGET, restart]]);
    const quiet = measured([
      [0.2, 0.8],
      [1.5, 2.5],
    ]);
    const lines = (edits: Parameters<typeof applyEdits>[1]) => {
      const cutView = timelineWords(applyEdits(stringout, edits), heard);
      return joinAuditText(cutView, auditJoins(cutView, heard, quiet))
        .split("\n")
        .slice(3);
    };
    expect(lines([{ kind: "removeRange", start: 54, end: 84, ripple: true }])).toEqual([
      'J A1 @54 (0.90s) #1:0|#1:0~84: 1:I 2:think [-60 dBFS] | [-60 dBFS] 3:I 4:think 5:so. · repeats "I think"',
    ]);
    // The first saying removed: nothing repeats and both edges sit in room tone.
    expect(lines([{ kind: "removeRange", start: 6, end: 84, ripple: true }])).toEqual([
      "J A1 @6 (0.10s) #1:0|#1:0~84: (no words) [-60 dBFS] | [-60 dBFS] 1:I 2:think 3:so. · ok",
    ]);
  });
});

describe("wordsText", () => {
  it("says what sounds in each gap of 0.4 s or more, and reads in pages", () => {
    expect(wordsText(view, { levels }).split("\n").slice(2)).toEqual([
      "1:So@30 2:um@60 3:we@90 4:go@108 (1.20s quiet) 5:now@198",
    ]);
    expect(
      wordsText(view, { levels: measured([...sound, [2.5, 2.8]]) })
        .split("\n")
        .at(-1),
    ).toBe("1:So@30 2:um@60 3:we@90 4:go@108 (1.20s, 0.30s sound @150-168) 5:now@198");
    expect(wordsText(view).split("\n").at(-1)).toContain("(1.20s unmeasured) 5:now@198");
    expect(wordsText(view, { levels, fromWord: 3, limit: 2 }).split("\n").slice(1)).toEqual([
      "A1 0-240 #1:0 a.MOV",
      "3:we@90 4:go@108",
      "# words 3-4 of 5; read on with from 5",
    ]);
  });
});
