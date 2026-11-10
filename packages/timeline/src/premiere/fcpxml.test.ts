import { describe, expect, it } from "vite-plus/test";

import { footageStringout } from "../footage.ts";
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
});
