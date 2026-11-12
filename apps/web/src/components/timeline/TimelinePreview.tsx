import type { TimelineLayout } from "@t3tools/timeline/layout";
import { useEffect, useEffectEvent, useRef } from "react";

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the canvas engine's lifetime: decoders, animation frames and a resize observer.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const engine = new PreviewEngine(canvas, {
      onTime: (frame, now) => onTime(frame, now),
      onSpeed: (speed) => onSpeed(speed),
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

  return (
    <canvas
      ref={canvasRef}
      className="h-full max-w-full rounded-sm bg-black"
      style={{ aspectRatio: `${props.frame.width} / ${props.frame.height}` }}
    />
  );
}
