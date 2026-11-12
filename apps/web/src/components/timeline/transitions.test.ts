import type { LaidOutClip, TimelineLayout } from "@t3tools/timeline/layout";
import { describe, expect, it } from "vite-plus/test";

import { mixAt, planTransitions, transitionKind, windowEnd, windowStart } from "./transitions";

const clip = (key: string, startFrame: number, endFrame: number) =>
  ({ key, startFrame, endFrame, clip: {} }) as unknown as LaidOutClip;

// V1: a 0-100, b 100-200, then c 300-400 on its own.  A1: x 0-100, y 100-200.
const layout: TimelineLayout = {
  rate: 30,
  durationFrames: 400,
  tracks: [
    {
      name: "V1",
      kind: "Video",
      clips: [clip("a", 0, 100), clip("b", 100, 200), clip("c", 300, 400)],
      metadata: {
        premiere: {
          transitions: [
            { name: "Cross Dissolve", startFrame: 90, endFrame: 110, cutFrame: 100 },
            // Older pulls have no cut frame or match name: the clips' edges place it.
            { name: "Dip to Black", startFrame: 300, endFrame: 320 },
            { name: "Dip to White", startFrame: 190, endFrame: 200, incoming: false },
            { name: "Push", startFrame: 380, endFrame: 400, matchName: "AE.ADBE Push" },
            // Its clips were moved away since the pull.
            { name: "Cross Dissolve", startFrame: 240, endFrame: 260, cutFrame: 250 },
          ],
        },
      },
    },
    {
      name: "A1",
      kind: "Audio",
      clips: [clip("x", 0, 100), clip("y", 100, 200)],
      metadata: {
        premiere: {
          transitions: [{ name: "Constant Power", startFrame: 80, endFrame: 120, cutFrame: 100 }],
        },
      },
    },
  ],
};

describe("planTransitions", () => {
  const plan = planTransitions(layout);

  it("ties each transition to the clips either side of its cut", () => {
    expect(plan.get("a")).toMatchObject({ in: null, out: { kind: "dissolve", twoSided: true } });
    expect(plan.get("b")).toMatchObject({
      in: { kind: "dissolve", start: 90, end: 110, twoSided: true },
      out: { kind: "dip-white", twoSided: false },
    });
    expect(plan.get("c")).toMatchObject({
      in: { kind: "dip-black", twoSided: false },
      // Not drawn: kept so the Monitor can name it, and played as a cut.
      out: { kind: null, name: "Push" },
    });
    expect(plan.get("x")?.out).toMatchObject({ kind: "constant-power", twoSided: true });
  });

  it("plays a clip across its transitions, and no further for one it cannot draw", () => {
    const [a, b, c] = layout.tracks[0]?.clips ?? [];
    expect(windowEnd(a!, plan.get("a"))).toBe(110);
    expect(windowStart(b!, plan.get("b"))).toBe(90);
    expect(windowEnd(c!, plan.get("c"))).toBe(400);
  });

  it("names what it draws by Premiere's names, per kind of track", () => {
    expect(transitionKind("Video", { matchName: "AE.ADBE Cross Dissolve New" })).toBe("dissolve");
    expect(transitionKind("Video", { name: "Film Dissolve" })).toBe("dissolve");
    expect(transitionKind("Audio", { name: "Exponential Fade" })).toBe("exponential");
    expect(transitionKind("Audio", { name: "Cross Dissolve" })).toBeNull();
    expect(transitionKind("Video", { name: "Constant Power" })).toBeNull();
  });
});

describe("mixAt", () => {
  const plan = planTransitions(layout);
  const at = (key: string, frame: number) => ({ ...mixAt(plan.get(key), frame) });

  it("dissolves the incoming clip in over the outgoing one", () => {
    expect(at("a", 95)).toMatchObject({ opacity: 1, visible: true });
    expect(at("b", 95).opacity).toBeCloseTo(0.25);
    expect(at("b", 105).opacity).toBeCloseTo(0.75);
    // Outside the transition a clip is untouched.
    expect(at("b", 150)).toEqual({ opacity: 1, dip: 0, dipWhite: false, gain: 1, visible: true });
  });

  it("dips a lone clip from the colour and to it", () => {
    expect(at("c", 300)).toMatchObject({ dip: 1, dipWhite: false, visible: true });
    expect(at("c", 315).dip).toBeCloseTo(0.25);
    expect(at("b", 195)).toMatchObject({ dipWhite: true, opacity: 1 });
    expect(at("b", 195).dip).toBeCloseTo(0.5);
  });

  it("gives a two-sided dip half each: out to the colour, then in from it", () => {
    const span = {
      name: "Dip to Black",
      kind: "dip-black",
      start: 0,
      end: 20,
      twoSided: true,
    } as const;
    const outgoing = { in: null, out: span };
    const incoming = { in: span, out: null };
    expect(mixAt(outgoing, 5)).toMatchObject({ visible: true, dip: 0.5 });
    expect(mixAt(incoming, 5).visible).toBe(false);
    expect(mixAt(outgoing, 15).visible).toBe(false);
    expect(mixAt(incoming, 15)).toMatchObject({ visible: true, dip: 0.5 });
  });

  it("crossfades audio at constant power, so the two halves never dip in loudness", () => {
    for (const frame of [80, 90, 100, 110, 119]) {
      const out = at("x", frame).gain;
      const into = at("y", frame).gain;
      expect(out * out + into * into).toBeCloseTo(1);
    }
    expect(at("x", 100).gain).toBeCloseTo(Math.SQRT1_2);
    expect(at("y", 80).gain).toBe(0);
  });

  it("leaves an undrawn transition as a cut", () => {
    expect(at("c", 390)).toEqual({ opacity: 1, dip: 0, dipWhite: false, gain: 1, visible: true });
  });
});
