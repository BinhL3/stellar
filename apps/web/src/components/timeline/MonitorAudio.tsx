import { AudioLinesIcon, VolumeXIcon } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { Button } from "~/components/ui/button";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { resolveStorage } from "~/lib/storage";

import type { AudioStatus } from "./audioEngine";
import type { PreviewEngine } from "./previewEngine";

const useMonitorAudioStore = create<{
  readonly scrub: boolean;
  readonly setScrub: (scrub: boolean) => void;
}>()(
  persist((set) => ({ scrub: true, setScrub: (scrub) => set({ scrub }) }), {
    name: "stellar:monitor-audio",
    version: 1,
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
  }),
);

const NO_AUDIO: AudioStatus = { state: "off", silent: 0 };
const noSubscription = () => () => undefined;

// The meter spans this many decibels below full scale, and falls back this fast.
const METER_FLOOR_DB = -48;
const METER_FALL_PER_FRAME = 0.9;
const METER_WIDTH = 9;
const METER_HEIGHT = 18;

/**
 * Paints the output level as two bars. The engine calls the returned function from its own
 * animation frame, so the meter moves without React rendering.
 */
const meterPainter = (canvas: HTMLCanvasElement) => {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(METER_WIDTH * ratio);
  canvas.height = Math.round(METER_HEIGHT * ratio);
  const context = canvas.getContext("2d");
  const style = getComputedStyle(canvas);
  const shown = [0, 0];
  const drawn = [-1, -1];
  return (left: number, right: number) => {
    if (context === null) return;
    const { width, height } = canvas;
    const bar = Math.floor((width - ratio) / 2);
    for (const [channel, peak] of [left, right].entries()) {
      shown[channel] = Math.max(peak, shown[channel]! * METER_FALL_PER_FRAME);
      const db = 20 * Math.log10(Math.max(shown[channel]!, 1e-6));
      const filled = Math.round(height * Math.min(1, Math.max(0, 1 - db / METER_FLOOR_DB)));
      // Clipping shows as a full bar in the warning colour.
      const lit = shown[channel]! >= 0.98 ? height + 1 : filled;
      if (lit === drawn[channel]) continue;
      drawn[channel] = lit;
      const x = channel * (bar + ratio);
      context.clearRect(x, 0, bar, height);
      context.globalAlpha = 0.2;
      context.fillStyle = style.color;
      context.fillRect(x, 0, bar, height);
      context.globalAlpha = lit > height ? 1 : 0.75;
      context.fillStyle = lit > height ? style.getPropertyValue("--destructive") : style.color;
      context.fillRect(x, height - filled, bar, filled);
    }
  };
};

/** The Monitor's sound controls: the scrub audio toggle, the output meter and what is silent. */
export function MonitorAudio(props: { readonly engine: PreviewEngine | null }) {
  const { engine } = props;
  const scrub = useMonitorAudioStore((state) => state.scrub);
  const setScrub = useMonitorAudioStore((state) => state.setScrub);
  const status = useSyncExternalStore(
    engine?.subscribeAudioStatus ?? noSubscription,
    () => engine?.audioStatus ?? NO_AUDIO,
  );
  const meterRef = useRef<HTMLCanvasElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Hands the setting and the meter's canvas to the engine, which lives outside React.
  useEffect(() => {
    if (engine === null) return;
    engine.setScrubAudio(scrub);
    const canvas = meterRef.current;
    if (canvas !== null) engine.setMeter(meterPainter(canvas));
    return () => engine.setMeter(null);
  }, [engine, scrub]);

  const silent =
    status.silent === 1
      ? "One clip here has no sound yet: its audio is still being prepared."
      : `${status.silent} clips here have no sound yet: their audio is still being prepared.`;
  return (
    <>
      {status.state === "blocked" || status.silent > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={status.state === "blocked" ? "Turn sound on" : "Some clips are silent"}
                onClick={() => engine?.unlockAudio()}
              />
            }
          >
            <VolumeXIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {status.state === "blocked"
              ? "The browser is holding sound back. Click to turn it on."
              : silent}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle size="xs" aria-label="Scrub audio" pressed={scrub} onPressedChange={setScrub} />
          }
        >
          <AudioLinesIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">
          Play a moment of sound when you step or drag the playhead
        </TooltipPopup>
      </Tooltip>
      <canvas
        ref={meterRef}
        aria-hidden
        className="shrink-0 text-muted-foreground"
        style={{ width: METER_WIDTH, height: METER_HEIGHT }}
      />
    </>
  );
}
