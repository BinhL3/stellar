import type { TimelineAction } from "@t3tools/timeline/premiere/shortcuts";
import { useEffect, useLayoutEffect, useRef } from "react";
import { create } from "zustand";

/** What the open timeline's panels let the command palette do. */
export interface TimelineCommandHandlers {
  /** Runs an editor action as its key would; false when it doesn't apply now. */
  readonly runAction: (action: TimelineAction) => boolean;
  readonly importFootage: () => void;
  readonly recordVoiceOver: () => void;
  readonly pullFromPremiere: () => void;
  readonly openInPremiere: () => void;
  readonly checkRender: () => void;
}

export type TimelineCommand = keyof TimelineCommandHandlers;

type Provided = { readonly [K in TimelineCommand]?: ReadonlyArray<{ current: unknown }> };

const useProvided = create<Provided>(() => ({}));

/** The commands some mounted panel provides right now. */
export const useTimelineCommands = (): ReadonlySet<TimelineCommand> => {
  const provided = useProvided();
  return new Set(
    (Object.keys(provided) as TimelineCommand[]).filter(
      (command) => (provided[command]?.length ?? 0) > 0,
    ),
  );
};

/** The latest provider of a command, which is the one most recently mounted. */
export const timelineCommand = <K extends TimelineCommand>(
  command: K,
): TimelineCommandHandlers[K] | null =>
  (useProvided.getState()[command]?.at(-1)?.current as TimelineCommandHandlers[K] | undefined) ??
  null;

/** Offers a command to the palette while the calling component is mounted and `handler` is set. */
export function useProvideTimelineCommand<K extends TimelineCommand>(
  command: K,
  handler: TimelineCommandHandlers[K] | null,
): void {
  const latest = useRef<unknown>(handler);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps the registry entry pointing at this render's handler, so the palette runs current state.
  useLayoutEffect(() => {
    latest.current = handler;
  });
  const enabled = handler !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Registers this panel's handler in the module registry the command palette reads, for as long as the panel is mounted.
  useEffect(() => {
    if (!enabled) return;
    const entry = latest;
    useProvided.setState((state) => ({ [command]: [...(state[command] ?? []), entry] }));
    return () =>
      useProvided.setState((state) => ({
        [command]: (state[command] ?? []).filter((candidate) => candidate !== entry),
      }));
  }, [command, enabled]);
}

/** `useProvideTimelineCommand` as an element, for a component that returns before it can call it. */
export function ProvideTimelineCommand<K extends TimelineCommand>(props: {
  readonly command: K;
  readonly handler: TimelineCommandHandlers[K] | null;
}): null {
  useProvideTimelineCommand(props.command, props.handler);
  return null;
}
