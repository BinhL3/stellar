import { describe, expect, it } from "vite-plus/test";

import { footageStringout } from "../footage.ts";
import { frameSeconds, frameTableFrom } from "../frameTimes.ts";
import { TIMELINE_NAMESPACE, timeRange } from "../otio.ts";
import { linearTimeWarp } from "../speed.ts";
import { toFcpXml } from "./fcpxml.ts";

describe("toFcpXml", () => {
  it("writes the cut in sequence frames with each file once, V1 first", () => {
    const timeline = footageStringout(
      [
        { target: "Footage/00 Raw (Oct 10)/a.MOV", duration: 2, width: 1080, height: 1920 },
        { target: "Footage/b & c.MOV", duration: 1, width: 1080, height: 1920 },
      ],
      "/Volumes/SSD/Jollibee",
    );
    const { xml, skipped } = toFcpXml(timeline, {
      sequenceName: "Footage (Stellar)",
      media: { "Footage/b & c.MOV": { duration: 1.5, width: 2160, height: 3840 } },
    });
    expect(skipped).toEqual([]);
    expect(xml).toContain("<name>Footage (Stellar)</name><duration>180</duration>");
    expect(xml).toContain("<timebase>60</timebase><ntsc>FALSE</ntsc>");
    expect(xml).toContain(
      '<start>120</start><end>180</end><in>0</in><out>60</out><file id="file-2">',
    );
    expect(xml).toContain(
      "<pathurl>file://localhost/Volumes/SSD/Jollibee/Footage/b%20%26%20c.MOV</pathurl>",
    );
    expect(xml).toContain("Footage/00%20Raw%20%28Oct%2010%29/a.MOV");
    // A known file gives its real length and size; an unknown one covers what the cut uses.
    expect(xml).toContain("<duration>90</duration><timecode>");
    expect(xml).toContain("<width>2160</width><height>3840</height>");
    expect(xml).toContain("<duration>120</duration><timecode>");
    // Each file is described once; Premiere needs stereo audio as a pair of tracks.
    expect(xml.match(/<pathurl>/g)).toHaveLength(2);
    expect(xml.match(/<track premiereTrackType="Stereo"/g)).toHaveLength(2);
    expect(xml.match(/<sourcetrack><mediatype>audio<\/mediatype><trackindex>2</g)).toHaveLength(2);
  });

  it("takes a variable-rate clip's source frame from its frame table", () => {
    const timeline = footageStringout(
      [{ target: "Footage/a.MOV", duration: 5, width: 1080, height: 1920 }],
      "/media",
    );
    // The clip starts 3 s into its source and runs one second.
    const from3 = {
      ...timeline,
      tracks: {
        ...timeline.tracks,
        children: timeline.tracks.children.map((track) => ({
          ...track,
          children: track.children.map((child) => ({
            ...child,
            source_range: timeRange(180, 60, 60),
          })),
        })),
      },
    };
    // Two seconds at 60 fps, then 30: second 3 is source frame 150, not 180.
    const ticks = [
      ...Array.from({ length: 120 }, (_, i) => i * 10),
      ...Array.from({ length: 90 }, (_, i) => 1200 + i * 20),
    ];
    const frameTimes = { "Footage/a.MOV": frameSeconds(frameTableFrom(ticks, 600)) };
    expect(toFcpXml(from3, { sequenceName: "x" }).xml).toContain("<in>180</in><out>240</out>");
    expect(toFcpXml(from3, { sequenceName: "x", frameTimes }).xml).toContain(
      "<in>150</in><out>210</out>",
    );
  });

  it("reports clips it can't carry instead of dropping them silently", () => {
    const timeline = footageStringout(
      [{ target: "Footage/a.MOV", duration: 1, width: 1080, height: 1920 }],
      "/media",
    );
    const [video] = timeline.tracks.children;
    const titled = {
      ...timeline,
      tracks: {
        ...timeline.tracks,
        children: [
          {
            ...video!,
            children: [
              {
                ...video!.children[0]!,
                name: "Title",
                media_references: {
                  DEFAULT_MEDIA: {
                    OTIO_SCHEMA: "ExternalReference.1" as const,
                    target_url: "",
                    metadata: {},
                  },
                },
              },
            ],
          },
        ],
      },
    };
    expect(toFcpXml(titled, { sequenceName: "x" }).skipped).toEqual(["V1: Title (no media file)"]);
  });

  it("says which clips lost their speed and that captions stayed behind", () => {
    const timeline = footageStringout(
      [{ target: "Footage/a.MOV", duration: 4, width: 1080, height: 1920 }],
      "/media",
    );
    const [video, ...rest] = timeline.tracks.children;
    const fast = {
      ...timeline,
      tracks: {
        ...timeline.tracks,
        children: [
          {
            ...video!,
            children: video!.children.map((child) =>
              child.OTIO_SCHEMA === "Clip.2" ? { ...child, effects: [linearTimeWarp(-2)] } : child,
            ),
          },
          {
            ...video!,
            name: "C1",
            metadata: { [TIMELINE_NAMESPACE]: { captions: true } },
          },
          ...rest,
        ],
      },
    };
    const exported = toFcpXml(fast, { sequenceName: "x" });
    expect(exported.approximated).toEqual([
      "V1: a.MOV (reversed, 200% speed is not written; set it in Premiere)",
    ]);
    expect(exported.skipped).toEqual(["C1: 1 captions (captions are not written)"]);
    // The file is as long as the media the clip plays, not as its length on the track.
    expect(exported.xml).toContain("<duration>480</duration><timecode>");
    expect(exported.xml.match(/<track>/g)).toHaveLength(1);
  });
});
