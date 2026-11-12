import type { PlacedMarker } from "@t3tools/timeline/markers";
import { CheckIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Kbd } from "~/components/ui/kbd";
import { Toggle } from "~/components/ui/toggle";
import { cn } from "~/lib/utils";

import { MarkerEditor, type MarkerPatch } from "./MarkerEditor";
import { MarkerGlyph, markerTitle } from "./markerLook";

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
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-2 text-xs">
        <span className="px-1 text-muted-foreground">
          {markers.length - resolved} open{resolved > 0 ? `, ${resolved} resolved` : ""}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {resolved > 0 ? (
            <Toggle size="xs" pressed={showResolved} onPressedChange={setShowResolved}>
              <CheckIcon />
              Resolved
            </Toggle>
          ) : null}
          {props.onAdd ? (
            <Button size="xs" variant="ghost" onClick={props.onAdd}>
              <PlusIcon />
              Add <Kbd>M</Kbd>
            </Button>
          ) : null}
        </span>
      </div>
      {markers.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No markers yet</EmptyTitle>
            <EmptyDescription>
              Press M in the timeline to leave a note at the playhead. An agent reads your notes,
              answers them and leaves its own here. Markers set in Premiere come in with each save.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-px overflow-auto p-1.5">
          {listed.map((marker) => {
            const selected = marker.id === props.selectedId;
            return (
              <li key={marker.id} className={cn("rounded-md", selected && "bg-accent/60")}>
                <button
                  type="button"
                  aria-expanded={selected}
                  onClick={() => {
                    props.onSeek(marker.frame);
                    props.onSelect(selected ? null : marker.id);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    !selected && "hover:bg-accent",
                  )}
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
                    <SparklesIcon
                      aria-label="From the agent"
                      className="mt-1 size-3 shrink-0 text-muted-foreground"
                    />
                  ) : null}
                </button>
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
