import { describe, expect, it } from "vite-plus/test";

import { footageStringout } from "./footage.ts";
import { layoutTimeline } from "./layout.ts";
import { TIMELINE_NAMESPACE } from "./otio.ts";

describe("footage", () => {
  it("lays footage back to back in the common frame, fitting a clip of another shape", () => {
    const timeline = footageStringout(
      [
        { target: "Footage/a.MOV", duration: 2, width: 2160, height: 3840 },
        { target: "Footage/b.MOV", duration: 1.5, width: 3840, height: 2160 },
        { target: "Footage/c.MOV", duration: 1, width: 2160, height: 3840 },
      ],
      "/media",
    );
    const layout = layoutTimeline(timeline);
    expect(layout.durationFrames).toBe(270);
    const [video, audio] = layout.tracks;
    expect(video?.clips.map((clip) => [clip.startFrame, clip.endFrame])).toEqual([
      [0, 120],
      [120, 210],
      [210, 270],
    ]);
    expect(audio?.clips).toHaveLength(3);
    expect(timeline.metadata[TIMELINE_NAMESPACE]).toMatchObject({
      frame: { width: 2160, height: 3840 },
      mediaRoot: "/media",
    });
    expect(video?.clips.map((clip) => clip.clip.metadata[TIMELINE_NAMESPACE])).toEqual([
      undefined,
      { transform: { scale: 56.25 } },
      undefined,
    ]);
  });
});
