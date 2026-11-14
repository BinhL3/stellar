import type { TimelineLayout } from "@t3tools/timeline/layout";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { PreviewEngine, type PreviewSource } from "./previewEngine";

export interface PreviewMediaSource extends PreviewSource {
  readonly peaks?: string | null;
}

export interface PreviewMedia {
  /** By each clip's `target_url`. */
  readonly sources: ReadonlyMap<string, PreviewMediaSource>;
  /** True when playback uses proxies; false when it falls back to the original files. */
  readonly proxied: boolean;
}

/** The canvas the engine draws on. The parent drives the engine through `onEngine`. */
export function TimelinePreview(props: {
  readonly layout: TimelineLayout;
  readonly frame: { readonly width: number; readonly height: number };
  readonly media: PreviewMedia;
  readonly onEngine: (engine: PreviewEngine | null) => void;
  readonly onTime: (frame: number, now: number) => void;
  readonly onSpeed: (speed: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const onTime = useEffectEvent((frame: number, now: number) => props.onTime(frame, now));
  const onSpeed = useEffectEvent((speed: number) => props.onSpeed(speed));
  const { onEngine } = props;
  // What the engine can't draw at the playhead. It reports only when the list changes.
  const [notDrawn, setNotDrawn] = useState<ReadonlyArray<string>>([]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the canvas engine's lifetime: decoders, animation frames and a resize observer.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const engine = new PreviewEngine(canvas, {
      onTime: (frame, now) => onTime(frame, now),
      onSpeed: (speed) => onSpeed(speed),
      onNotDrawn: setNotDrawn,
    });
    engineRef.current = engine;
    onEngine(engine);
    return () => {
      onEngine(null);
      engineRef.current = null;
      engine.destroy();
    };
  }, [onEngine]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Hands the latest timeline to the engine, which lives outside React.
  useEffect(() => {
    engineRef.current?.setScene({
      layout: props.layout,
      frame: props.frame,
      sources: props.media.sources,
    });
  }, [props.layout, props.frame, props.media.sources]);

  const missing = notDrawn.join(", ");
  return (
    // Exactly the exported frame, as large as fits: black only ever means the frame.
    <div
      className="relative"
      style={{
        aspectRatio: `${props.frame.width} / ${props.frame.height}`,
        width: `min(100cqw, 100cqh * ${props.frame.width / props.frame.height})`,
      }}
    >
      <canvas ref={canvasRef} className="size-full bg-black" />
      {notDrawn.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded-sm bg-black/60 px-1.5 py-0.5 text-2xs leading-4 text-white/75" />
            }
          >
            Not drawn: {missing}
          </TooltipTrigger>
          <TooltipPopup side="top">
            The preview doesn't draw {missing}. Check it in Premiere.
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
