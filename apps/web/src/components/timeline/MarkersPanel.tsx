import type { PlacedMarker } from "@t3tools/timeline/markers";
import { CheckIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Kbd } from "~/components/ui/kbd";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { Bay } from "./bay";
import { MarkerEditor, type MarkerPatch } from "./MarkerEditor";
import { MarkerGlyph, markerTitle } from "./markerLook";
import { PanelTools } from "./TimelineWorkspace";

/**
 * Every marker on the timeline, to scan and jump between. The selected one opens for editing
 * in place. Resolved markers are tucked away until asked for, so the list is what is still open.
 */
export function MarkersPanel(props: {
  readonly markers: ReadonlyArray<PlacedMarker>;
  readonly timecode: (frame: number) => string;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onSeek: (frame: number) => void;
  /** Absent where the timeline can't be edited. */
  readonly onChange?: (patch: MarkerPatch) => void;
  readonly onRemove?: (id: string) => void;
  readonly onAdd?: () => void;
}) {
  const { markers, onChange } = props;
  const [showResolved, setShowResolved] = useState(false);
  const resolved = markers.filter((marker) => marker.resolved).length;
  const listed = markers.filter(
    (marker) => showResolved || !marker.resolved || marker.id === props.selectedId,
  );
  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-card-foreground">
      <PanelTools panel="markers">
        {resolved > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  size="sm"
                  aria-label="Show resolved markers"
                  pressed={showResolved}
                  onPressedChange={setShowResolved}
                />
              }
            >
              <CheckIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {showResolved ? "Hide" : "Show"} {resolved} resolved
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {props.onAdd ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Add a marker at the playhead"
                  onClick={props.onAdd}
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              Add a marker at the playhead <Kbd>M</Kbd>
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </PanelTools>
      {markers.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No markers yet</EmptyTitle>
          </EmptyHeader>
          {props.onAdd ? (
            <EmptyContent>
              <Button size="sm" variant="outline" onClick={props.onAdd}>
                Add marker <Kbd>M</Kbd>
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-px overflow-auto px-1.5 pb-1.5">
          {listed.map((marker) => {
            const selected = marker.id === props.selectedId;
            return (
              <Bay.Item key={marker.id} selected={selected}>
                <Bay.ItemButton
                  selected={selected}
                  aria-expanded={selected}
                  onClick={() => {
                    props.onSeek(marker.frame);
                    props.onSelect(selected ? null : marker.id);
                  }}
                >
                  <MarkerGlyph marker={marker} className="mt-1" />
                  <span className="w-12 shrink-0 font-mono text-2xs leading-5 text-muted-foreground tabular-nums">
                    {props.timecode(marker.frame)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={cn(
                        "min-w-0 truncate leading-5",
                        marker.resolved && "text-muted-foreground line-through",
                      )}
                    >
                      {markerTitle(marker)}
                    </span>
                    {!selected && marker.name !== "" && marker.note !== "" ? (
                      <span className="line-clamp-2 text-xs wrap-anywhere text-muted-foreground">
                        {marker.note}
                      </span>
                    ) : null}
                  </span>
                  {marker.author === "agent" ? (
                    <span className="sr-only">From the agent</span>
                  ) : null}
                </Bay.ItemButton>
                {selected ? (
                  <div className="px-2 pt-0.5 pb-2">
                    <MarkerEditor
                      marker={marker}
                      timecode={props.timecode(marker.frame)}
                      {...(onChange ? { onChange } : {})}
                      {...(props.onRemove ? { onRemove: () => props.onRemove?.(marker.id) } : {})}
                    />
                  </div>
                ) : null}
              </Bay.Item>
            );
          })}
        </ul>
      )}
    </div>
  );
}
