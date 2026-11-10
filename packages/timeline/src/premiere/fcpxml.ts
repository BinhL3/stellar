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
    /**
     * What is known about each media file, by `target_url`. Premiere refuses an XML whose
     * files don't describe their media, so files missing here get the sequence's own size and
     * a duration that just covers their use.
     */
    readonly media?: Readonly<
      Record<string, { readonly duration: number; readonly width: number; readonly height: number }>
    >;
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

  // The furthest source frame each file is used to, for files whose length isn't known.
  const usedTo = new Map<string, number>();
  for (const track of layout.tracks) {
    for (const item of track.clips) {
      const target = item.clip.media_references.DEFAULT_MEDIA.target_url;
      const { start_time, duration } = item.clip.source_range;
      const end = Math.ceil(((start_time.value + duration.value) / start_time.rate) * layout.rate);
      usedTo.set(target, Math.max(usedTo.get(target) ?? 0, end));
    }
  }
  const framesOf = (target: string) => {
    const known = options.media?.[target]?.duration;
    return known === undefined || known <= 0
      ? (usedTo.get(target) ?? 0)
      : Math.max(Math.round(known * layout.rate), usedTo.get(target) ?? 0);
  };

  const fileElement = (target: string, path: string, isAudio: boolean) => {
    const known = files.get(target);
    if (known !== undefined) return `<file id="${known}"/>`;
    const id = `file-${files.size + 1}`;
    files.set(target, id);
    const info = options.media?.[target];
    const hasPicture = !isAudio || (info !== undefined && info.width > 0);
    const picture = hasPicture
      ? `<video><samplecharacteristics>${rate}<width>${info?.width || frame.width}</width><height>${info?.height || frame.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>`
      : "";
    return `<file id="${id}"><name>${escape(path.slice(path.lastIndexOf("/") + 1))}</name><pathurl>${escape(pathUrl(path))}</pathurl>${rate}<duration>${framesOf(target)}</duration><timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media>${picture}<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file>`;
  };

  // `channel` is 1 or 2 for the two halves of a stereo track, 0 for video.
  const clipItem = (track: LaidOutTrack, item: LaidOutClip, id: string, channel: number) => {
    const target = item.clip.media_references.DEFAULT_MEDIA.target_url;
    const path = target === "" ? null : absolute(target);
    if (path === null) {
      if (channel < 2) {
        skipped.push(
          `${track.name}: ${item.clip.name} (${target === "" ? "no media file" : "media path unknown"})`,
        );
      }
      return "";
    }
    const { start_time } = item.clip.source_range;
    const sourceIn = Math.round((start_time.value / start_time.rate) * layout.rate);
    const start = Math.round(item.startFrame);
    const end = Math.round(item.endFrame);
    return `<clipitem id="${id}"${
      track.kind === "Audio" ? ' premiereChannelType="stereo"' : ""
    }><masterclipid>master-${target.replace(/[^\w]+/g, "-")}</masterclipid><name>${escape(item.clip.name)}</name><enabled>${
      item.clip.enabled === false ? "FALSE" : "TRUE"
    }</enabled><duration>${framesOf(target)}</duration>${rate}<start>${start}</start><end>${end}</end><in>${sourceIn}</in><out>${
      sourceIn + (end - start)
    }</out>${fileElement(target, path, track.kind === "Audio")}${
      track.kind === "Audio"
        ? `<sourcetrack><mediatype>audio</mediatype><trackindex>${channel}</trackindex></sourcetrack>`
        : ""
    }</clipitem>`;
  };

  const tracksOf = (kind: LaidOutTrack["kind"]) => {
    const tracks = layout.tracks.filter((track) => track.kind === kind);
    if (kind === "Video") {
      // The layout lists video from the top track down; xmeml lists it from V1 up.
      return tracks
        .toReversed()
        .map(
          (track, trackIndex) =>
            `<track>${track.clips
              .map((item, index) => clipItem(track, item, `V${trackIndex + 1}-${index + 1}`, 0))
              .join("")}</track>`,
        )
        .join("");
    }
    // Premiere reads a stereo track as a pair of xmeml tracks, one per channel; a single
    // track imports with no audio at all.
    return tracks
      .map((track, trackIndex) =>
        [1, 2]
          .map(
            (channel) =>
              `<track premiereTrackType="Stereo" currentExplodedTrackIndex="${channel - 1}" totalExplodedTrackCount="2">${track.clips
                .map((item, index) =>
                  clipItem(track, item, `A${trackIndex + 1}-${index + 1}-${channel}`, channel),
                )
                .join("")}</track>`,
          )
          .join(""),
      )
      .join("");
  };

  const video = tracksOf("Video");
  const audio = tracksOf("Audio");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="4"><sequence id="stellar-sequence"><name>${escape(options.sequenceName)}</name><duration>${Math.round(
    layout.durationFrames,
  )}</duration>${rate}<media><video><format><samplecharacteristics>${rate}<width>${frame.width}</width><height>${frame.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>${video}</video><audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format><outputs><group><index>1</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>1</index></channel></group><group><index>2</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>2</index></channel></group></outputs>${audio}</audio></media></sequence></xmeml>
`;
  return { xml, skipped };
};
