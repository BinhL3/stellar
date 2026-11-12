import { describe, expect, it } from "vite-plus/test";

import { derivePreflight, type PreflightFacts, preflightHeadline } from "./preflight.ts";

/** A short that is cut, exported, checked and posted. */
const finished: PreflightFacts = {
  scriptBeats: 9,
  footage: 25,
  intake: { state: "done", done: 25, total: 25 },
  proxies: { building: null, ready: 31, failed: 0 },
  transcripts: { ready: 27, total: 27, building: null, failed: 0, unavailable: false },
  premiere: "current",
  hasExport: true,
  render: { level: "pass", problems: 0, stale: null },
  posted: { urls: ["https://www.tiktok.com/@binh/video/1"] },
};

const summary = (facts: PreflightFacts) =>
  Object.fromEntries(
    derivePreflight(facts).map((step) => [step.id, [step.state, step.detail, step.action]]),
  );

describe("derivePreflight", () => {
  it("has nothing to say about a finished short", () => {
    const steps = derivePreflight(finished);
    expect(steps.map((step) => step.state)).toEqual(Array.from({ length: 8 }, () => "done"));
    expect(preflightHeadline(steps)).toBeNull();
    // The way back out of Posted is on the step itself.
    expect(steps.at(-1)).toMatchObject({ detail: "1 link", action: "unmarkPosted" });
  });

  it("names what a project started from an idea is missing, and what would fix it", () => {
    expect(
      summary({
        scriptBeats: 0,
        footage: 0,
        intake: null,
        proxies: null,
        transcripts: { ready: 0, total: 0, building: null, failed: 0, unavailable: true },
        premiere: "unlinked",
        hasExport: false,
        render: null,
        posted: null,
      }),
    ).toEqual({
      script: ["todo", "No script saved", "openScript"],
      footage: ["todo", "No footage imported", "importFootage"],
      proxies: ["todo", "Nothing to preview yet", null],
      // With nothing to transcribe, a missing transcriber is not yet a problem.
      transcripts: ["todo", "Nothing to transcribe yet", null],
      premiereLink: ["todo", "None linked", "linkPremiere"],
      premiereSync: ["todo", "Waits for a Premiere project", null],
      render: ["todo", "No export in Exports yet", null],
      posted: ["todo", "Not posted", "markPosted"],
    });
  });

  it("shows background work as working, and its failures as what they are", () => {
    const working = summary({
      ...finished,
      intake: { state: "copying", done: 3, total: 25 },
      proxies: { building: { done: 4, total: 31 }, ready: 4, failed: 0 },
      transcripts: {
        ready: 2,
        total: 27,
        building: { done: 2, total: 25 },
        failed: 0,
        unavailable: false,
      },
    });
    expect(working.footage).toEqual(["working", "Copying 3 of 25", null]);
    expect(
      summary({
        ...finished,
        intake: { state: "conforming", done: 25, total: 25, conform: { done: 1, total: 3 } },
      }).footage,
    ).toEqual(["working", "Conforming 2 of 3 to a constant frame rate", null]);
    expect(working.proxies).toEqual(["working", "Making 4 of 31", null]);
    expect(working.transcripts).toEqual(["working", "Transcribing 2 of 25", null]);

    const failed = summary({
      ...finished,
      intake: { state: "failed", done: 0, total: 25, error: "IMG_1.MOV is 3 bytes short" },
      proxies: { building: null, ready: 30, failed: 1 },
      transcripts: { ready: 20, total: 27, building: null, failed: 2, unavailable: false },
    });
    expect(failed.footage).toEqual([
      "fail",
      "Import failed: IMG_1.MOV is 3 bytes short",
      "importFootage",
    ]);
    expect(failed.proxies).toEqual(["warn", "1 file has no preview", null]);
    // A build that could not run at all says why, whatever an earlier build left ready.
    expect(
      summary({
        ...finished,
        proxies: { building: null, ready: 30, failed: 0, error: "ffmpeg is not installed." },
      }).proxies,
    ).toEqual(["fail", "ffmpeg is not installed.", "sync"]);
    expect(failed.transcripts).toEqual(["todo", "20 of 27 clips, 2 failed", "transcribe"]);
    expect(
      summary({
        ...finished,
        transcripts: { ready: 20, total: 27, building: null, failed: 0, unavailable: true },
      }).transcripts,
    ).toEqual(["warn", "No transcriber on this machine", null]);
  });

  it("tells the ways a timeline can be out of step with Premiere apart", () => {
    const sync = (premiere: PreflightFacts["premiere"]) =>
      summary({ ...finished, premiere }).premiereSync;
    expect(sync("behind")).toEqual(["warn", "Premiere has a newer save", "sync"]);
    expect(sync("edited")).toEqual(["todo", "Edits here aren't in Premiere yet", null]);
    expect(sync("conflict")).toEqual(["fail", "Edited here and in Premiere", "merge"]);
    expect(sync("offline")).toEqual(["warn", "The Premiere project can't be read", null]);
    expect(summary({ ...finished, premiere: "offline" }).premiereLink?.[0]).toBe("done");
  });

  it("stops trusting a render check once the timeline or the export has changed", () => {
    const render = (value: PreflightFacts["render"], hasExport = true) =>
      summary({ ...finished, render: value, hasExport }).render;
    expect(render(null)).toEqual(["todo", "Export not checked", "checkRender"]);
    expect(render({ level: "pass", problems: 0, stale: "timeline" })).toEqual([
      "warn",
      "Timeline changed since the check",
      "checkRender",
    ]);
    expect(render({ level: "pass", problems: 0, stale: "export" })).toEqual([
      "warn",
      "A newer export isn't checked",
      "checkRender",
    ]);
    expect(render({ level: "warn", problems: 2, stale: null })).toEqual([
      "warn",
      "2 to look at",
      "checkRender",
    ]);
    expect(render({ level: "fail", problems: 1, stale: null })).toEqual([
      "fail",
      "1 problem",
      "checkRender",
    ]);
  });
});

describe("preflightHeadline", () => {
  it("puts a failure ahead of earlier steps that are merely not done", () => {
    const steps = derivePreflight({
      ...finished,
      scriptBeats: 0,
      premiere: "conflict",
      posted: null,
    });
    expect(preflightHeadline(steps)?.id).toBe("premiereSync");
    expect(
      preflightHeadline(derivePreflight({ ...finished, scriptBeats: 0, posted: null }))?.id,
    ).toBe("script");
  });
});
