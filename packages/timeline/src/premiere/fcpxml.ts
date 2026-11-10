/**
 * Writes a timeline as Final Cut Pro 7 XML (xmeml), the interchange Premiere imports as a new
 * sequence with its items in time order. Only the cut travels: tracks, clip positions, source
 * ranges and enabled state. Effects, text graphics and anything without a media file stay
 * behind and are reported, so a push never claims more than it carried.
 */
import { layoutTimeline, type LaidOutClip, type LaidOutTrack } from "../layout.ts";
import { type Timeline, TIMELINE_NAMESPACE } from "../otio.ts";

export interface FcpXmlExport {
  readonly xml: string;
  /** Clips left out, as "track name: clip name (why)". */
  readonly skipped: ReadonlyArray<string>;
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** xmeml counts in whole frames of a nominal rate, flagged NTSC when the real rate is /1.001. */
const rateOf = (rate: number) => {
  const timebase = Math.round(rate);
  const ntsc = Math.abs(rate - timebase) > 0.001;
  return `<rate><timebase>${timebase}</timebase><ntsc>${ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`;
};

const pathUrl = (absolutePath: string) =>
  `file://localhost${absolutePath
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[()']/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/")}`;

export const toFcpXml = (
  timeline: Timeline,
  options: {
    readonly sequenceName: string;
    /** Media durations in seconds by `target_url`, where known; Premiere reads the rest itself. */
    readonly durations?: Readonly<Record<string, number>>;
  },
): FcpXmlExport => {
  const layout = layoutTimeline(timeline);
  const stellar = timeline.metadata[TIMELINE_NAMESPACE] as
    | { frame?: { width: number; height: number }; mediaRoot?: string }
    | undefined;
  const frame = stellar?.frame ?? { width: 1080, height: 1920 };
  const rate = rateOf(layout.rate);
  const skipped: Array<string> = [];
  const files = new Map<string, string>();

  const absolute = (target: string) =>
    target.startsWith("/")
      ? target
      : stellar?.mediaRoot === undefined
        ? null
        : `${stellar.mediaRoot.replace(/\/$/, "")}/${target}`;

  const fileElement = (target: string, path: string) => {
    const known = files.get(target);
    if (known !== undefined) return `<file id="${known}"/>`;
    const id = `file-${files.size + 1}`;
    files.set(target, id);
    const seconds = options.durations?.[target];
    return `<file id="${id}"><name>${escape(path.slice(path.lastIndexOf("/") + 1))}</name><pathurl>${escape(pathUrl(path))}</pathurl>${rate}${
      seconds === undefined ? "" : `<duration>${Math.round(seconds * layout.rate)}</duration>`
    }</file>`;
  };

  const clipItem = (track: LaidOutTrack, item: LaidOutClip, id: string) => {
    const target = item.clip.media_references.DEFAULT_MEDIA.target_url;
    const path = target === "" ? null : absolute(target);
    if (path === null) {
      skipped.push(
        `${track.name}: ${item.clip.name} (${target === "" ? "no media file" : "media path unknown"})`,
      );
      return "";
    }
    const { start_time } = item.clip.source_range;
    const sourceIn = Math.round((start_time.value / start_time.rate) * layout.rate);
    const start = Math.round(item.startFrame);
    const end = Math.round(item.endFrame);
    return `<clipitem id="${id}"><name>${escape(item.clip.name)}</name><enabled>${
      item.clip.enabled === false ? "FALSE" : "TRUE"
    }</enabled>${rate}<start>${start}</start><end>${end}</end><in>${sourceIn}</in><out>${
      sourceIn + (end - start)
    }</out>${fileElement(target, path)}${
      track.kind === "Audio"
        ? "<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>"
        : ""
    }</clipitem>`;
  };

  const tracksOf = (kind: LaidOutTrack["kind"]) => {
    const tracks = layout.tracks.filter((track) => track.kind === kind);
    // The layout lists video from the top track down; xmeml lists it from V1 up.
    return (kind === "Video" ? tracks.toReversed() : tracks)
      .map(
        (track, trackIndex) =>
          `<track>${track.clips
            .map((item, index) => clipItem(track, item, `${kind[0]}${trackIndex + 1}-${index + 1}`))
            .join("")}</track>`,
      )
      .join("");
  };

  const video = tracksOf("Video");
  const audio = tracksOf("Audio");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4"><sequence><name>${escape(options.sequenceName)}</name><duration>${Math.round(
    layout.durationFrames,
  )}</duration>${rate}<media><video><format><samplecharacteristics>${rate}<width>${frame.width}</width><height>${frame.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>${video}</video><audio><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>${audio}</audio></media></sequence></xmeml>
`;
  return { xml, skipped };
};
