import { create } from "zustand";

interface TimelineEditsState {
  /**
   * Plays the selected edit's cut: what it removed, then on the next call the join as it is.
   * Null unless the Edits panel has an edit selected that removed footage.
   */
  readonly listen: (() => void) | null;
  readonly setListen: (listen: (() => void) | null) => void;
}

/** What the Edits panel lets the timeline's keys and the command palette do. */
export const useTimelineEditsStore = create<TimelineEditsState>()((set) => ({
  listen: null,
  setListen: (listen) => set({ listen }),
}));

/** False when no selected edit removed footage, so a key bound to it falls through. */
export const listenToCut = (): boolean => {
  const { listen } = useTimelineEditsStore.getState();
  listen?.();
  return listen !== null;
};
