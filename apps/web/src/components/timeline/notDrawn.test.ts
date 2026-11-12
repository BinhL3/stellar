import type { LaidOutClip } from "@t3tools/timeline/layout";
import { describe, expect, it } from "vite-plus/test";

import { clipNotDrawn } from "./notDrawn";

const item = (target: string, stellar: object) =>
  ({
    clip: {
      media_references: { DEFAULT_MEDIA: { target_url: target } },
      metadata: { stellar },
    },
  }) as unknown as LaidOutClip;

const transform = (extra: object) => ({
  kind: "Transform",
  label: "Malice Slide In Down Fast",
  matchName: "AE.ADBE Geometry2",
  ...extra,
});

describe("clipNotDrawn", () => {
  it("lists what the engine leaves out and nothing it draws", () => {
    expect(
      clipNotDrawn(
        item("card.png", {
          blendMode: "linear-burn",
          effects: [
            { kind: "Motion", label: "Motion", matchName: "AE.ADBE Motion" },
            transform({ params: { shutter_angle: 360 } }),
            { kind: "Drop Shadow", label: "Drop Shadow", matchName: "AE.ADBE Drop Shadow" },
            { kind: "Lumetri Color", label: "Warm", matchName: "AE.ADBE Lumetri", bypassed: true },
          ],
        }),
      ),
    ).toEqual(["Drop Shadow", "linear burn blend"]);
  });

  it("still lists a Transform it has no values for, and the blur text does not get", () => {
    // Pulled before Transforms were described: only the blob is there.
    expect(clipNotDrawn(item("card.png", { effects: [transform({})] }))).toEqual([
      "Transform (Malice Slide In Down Fast)",
    ]);
    expect(
      clipNotDrawn(
        item("", { text: "Hi", effects: [transform({ params: { shutter_angle: 360 } })] }),
      ),
    ).toEqual(["Transform motion blur"]);
    expect(clipNotDrawn(item("", { effects: [transform({ params: {} })] }))).toEqual([]);
  });
});
