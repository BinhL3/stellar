import { type Clip, type Timeline, TIMELINE_NAMESPACE, type Track } from "./otio.ts";

/** A clip's stable id: one an edit gave it, else Premiere's track item id, else its position. */
export const clipIdOf = (clip: Clip, fallback: string): string => {
  const own = (clip.metadata[TIMELINE_NAMESPACE] as { id?: string } | undefined)?.id;
  const premiere = (clip.metadata["premiere"] as { nodeId?: string | null } | undefined)?.nodeId;
  return own ?? premiere ?? fallback;
};

export interface LaidOutClip {
  readonly key: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly clip: Clip;
}

export interface LaidOutTrack {
  readonly name: string;
  readonly kind: Track["kind"];
  readonly clips: ReadonlyArray<LaidOutClip>;
}

export interface TimelineLayout {
  readonly rate: number;
  readonly durationFrames: number;
  /** Video tracks top-down from the highest, then audio tracks, as editors stack them. */
  readonly tracks: ReadonlyArray<LaidOutTrack>;
}

const round = (frames: number): number => Math.round(frames * 1000) / 1000;

/** Places every clip in timeline frames, using OTIO's rule that children play back to back. */
export const layoutTimeline = (timeline: Timeline): TimelineLayout => {
  const rate = timeline.global_start_time.rate;
  let durationFrames = 0;
  const tracks = timeline.tracks.children.map((track, trackIndex): LaidOutTrack => {
    let cursor = 0;
    const clips: Array<LaidOutClip> = [];
    track.children.forEach((child, childIndex) => {
      const { duration } = child.source_range;
      const length = round((duration.value / duration.rate) * rate);
      if (child.OTIO_SCHEMA === "Clip.2") {
        clips.push({
          key: clipIdOf(child, `${trackIndex}:${childIndex}`),
          startFrame: round(cursor),
          endFrame: round(cursor + length),
          clip: child,
        });
      }
      cursor += length;
    });
    durationFrames = Math.max(durationFrames, round(cursor));
    return { name: track.name, kind: track.kind, clips };
  });
  const video = tracks.filter((t) => t.kind === "Video").toReversed();
  const audio = tracks.filter((t) => t.kind === "Audio");
  return { rate, durationFrames, tracks: [...video, ...audio] };
};
