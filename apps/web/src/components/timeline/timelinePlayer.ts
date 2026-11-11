import { createContext, use } from "react";

/** What a panel beside the timeline needs to follow and move the playhead. */
interface TimelinePlayer {
  /** The playhead in timeline frames; it changes every frame during playback. */
  readonly playhead: {
    readonly get: () => number;
    readonly subscribe: (listener: () => void) => () => void;
  };
  readonly seek: (frame: number) => void;
  readonly rate: number;
}

/** Provided by the timeline viewer to its `aside`. */
export const TimelinePlayerContext = createContext<TimelinePlayer | null>(null);

export function useTimelinePlayer(): TimelinePlayer {
  const player = use(TimelinePlayerContext);
  if (player === null) throw new Error("useTimelinePlayer needs a timeline viewer above it.");
  return player;
}
