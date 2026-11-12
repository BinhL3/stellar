import type { PlacedMarker } from "@t3tools/timeline/markers";
import { useRef, useState } from "react";

import { Popover, PopoverPopup } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { MarkerEditor, type MarkerPatch } from "./MarkerEditor";
import { MarkerGlyph, markerFill, markerTitle } from "./markerLook";

/** A script line's start on the ruler. */
export interface ScriptTick {
  readonly id: string;
  readonly frame: number;
  /** The line's section or first words, shown on hover. */
  readonly label: string;
}

// A press that moves less than this selects the marker; further, it drags it.
const DRAG_THRESHOLD_PX = 3;

/**
 * What the ruler shows besides time: markers along its top, script lines as notches along its
 * bottom. It renders with the ruler, never per frame; a drag re-renders only this layer.
 */
export function RulerMarkers(props: {
  readonly markers: ReadonlyArray<PlacedMarker>;
  readonly scriptTicks: ReadonlyArray<ScriptTick>;
  readonly duration: number;
  readonly pxPerFrame: number;
  readonly timecode: (frame: number) => string;
  readonly selectedId: string | null;
  /** Whether the selected marker's editor opens here, under its mark. */
  readonly editing: boolean;
  readonly onSelect: (id: string | null) => void;
  readonly onSeek: (frame: number) => void;
  /** Absent where the timeline can't be edited. */
  readonly onChange?: (patch: MarkerPatch) => void;
  readonly onRemove?: (id: string) => void;
  readonly onScriptTick: (tick: ScriptTick) => void;
}) {
  const { markers, duration, pxPerFrame, onChange } = props;
  const [drag, setDrag] = useState<{ id: string; frame: number } | null>(null);
  const pressRef = useRef<{ id: string; x: number; frame: number; moved: boolean } | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const percent = (frame: number) => `${(frame / duration) * 100}%`;
  const selected = markers.find((marker) => marker.id === props.selectedId) ?? null;

  return (
    <>
      {props.scriptTicks.map((tick) => (
        <Tooltip key={tick.id}>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Script line: ${tick.label}`}
                // The ruler scrubs on a press; a notch is a click of its own.
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={() => props.onScriptTick(tick)}
                className="group/tick absolute bottom-0 z-10 flex h-3 w-2 -translate-x-1/2 cursor-pointer items-end justify-center outline-none"
                style={{ left: percent(tick.frame) }}
              />
            }
          >
            <span className="h-2 w-0.5 rounded-t-full bg-primary/55 group-hover/tick:h-3 group-hover/tick:bg-primary group-focus-visible/tick:bg-primary" />
          </TooltipTrigger>
          <TooltipPopup side="top">{tick.label}</TooltipPopup>
        </Tooltip>
      ))}
      {markers.map((marker) => {
        const frame = drag?.id === marker.id ? drag.frame : marker.frame;
        const isSelected = marker.id === props.selectedId;
        return (
          <span key={marker.id} className="contents">
            {marker.durationFrames > 0 ? (
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute top-0 h-1 rounded-r-full opacity-50",
                  markerFill(marker.color),
                  marker.resolved && "opacity-25",
                )}
                style={{ left: percent(frame), width: percent(marker.durationFrames) }}
              />
            ) : null}
            <button
              type="button"
              ref={isSelected ? setAnchor : undefined}
              aria-label={`Marker: ${markerTitle(marker)} at ${props.timecode(marker.frame)}`}
              aria-pressed={isSelected}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                pressRef.current = {
                  id: marker.id,
                  x: event.clientX,
                  frame: marker.frame,
                  moved: false,
                };
              }}
              onPointerMove={(event) => {
                const press = pressRef.current;
                if (press === null || press.id !== marker.id || onChange === undefined) return;
                const moved = event.clientX - press.x;
                if (!press.moved && Math.abs(moved) < DRAG_THRESHOLD_PX) return;
                press.moved = true;
                const next = Math.round(press.frame + moved / Math.max(pxPerFrame, 1e-6));
                setDrag({ id: marker.id, frame: Math.min(Math.max(0, next), duration) });
              }}
              onPointerUp={() => {
                const press = pressRef.current;
                pressRef.current = null;
                if (press === null) return;
                if (press.moved && drag !== null) {
                  if (drag.frame !== marker.frame)
                    onChange?.({ markerId: marker.id, frame: drag.frame });
                  setDrag(null);
                  return;
                }
                props.onSeek(marker.frame);
                props.onSelect(marker.id);
              }}
              onPointerCancel={() => {
                pressRef.current = null;
                setDrag(null);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              className={cn(
                "absolute top-0 z-20 flex h-4 w-4 -translate-x-1/2 touch-none items-start justify-center rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                onChange ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                isSelected && "ring-1 ring-foreground/60",
              )}
              style={{ left: percent(frame) }}
            >
              <MarkerGlyph marker={marker} />
            </button>
          </span>
        );
      })}
      <Popover
        open={props.editing && selected !== null && anchor !== null && drag === null}
        onOpenChange={(open) => {
          if (!open) props.onSelect(null);
        }}
      >
        <PopoverPopup anchor={anchor} side="bottom" align="start" width="sm" padding="compact">
          {selected ? (
            <MarkerEditor
              marker={selected}
              timecode={props.timecode(selected.frame)}
              autoFocus={selected.name === "" && selected.note === ""}
              {...(onChange ? { onChange } : {})}
              {...(props.onRemove ? { onRemove: () => props.onRemove?.(selected.id) } : {})}
            />
          ) : null}
        </PopoverPopup>
      </Popover>
    </>
  );
}
