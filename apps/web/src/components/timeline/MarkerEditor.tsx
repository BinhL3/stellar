import type { MarkerEdit, PlacedMarker } from "@t3tools/timeline/markers";
import { PREMIERE_MARKER_COLORS } from "@t3tools/timeline/markers";
import { CheckIcon, SparklesIcon, Trash2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Toggle } from "~/components/ui/toggle";
import { cn } from "~/lib/utils";

import { MARKER_COLOR_LABELS, markerFill } from "./markerLook";

export type MarkerPatch = Omit<Extract<MarkerEdit, { readonly kind: "setMarker" }>, "kind">;

/**
 * A marker's name, note, colour and resolved state. Text is saved when the field is left or
 * Enter is pressed, so each change is one step of undo, not one per keystroke.
 */
export function MarkerEditor(props: {
  readonly marker: PlacedMarker;
  readonly timecode: string;
  /** Absent where the timeline can't be edited: the marker is then only shown. */
  readonly onChange?: (patch: MarkerPatch) => void;
  readonly onRemove?: () => void;
  readonly autoFocus?: boolean;
}) {
  const { marker, onChange } = props;
  const change = (patch: Omit<MarkerPatch, "markerId">) =>
    onChange?.({ markerId: marker.id, ...patch });
  return (
    <div
      className="flex flex-col gap-2 text-xs"
      // The fields sit inside the timeline's shortcut scope; a Space here is a space.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span className="font-mono text-2xs tabular-nums">{props.timecode}</span>
        {marker.clipId !== null ? (
          <span>· on a clip{marker.track ? ` (${marker.track})` : ""}</span>
        ) : null}
        {marker.author === "agent" ? (
          <span className="ml-auto flex items-center gap-1 text-foreground/80">
            <SparklesIcon className="size-3" />
            From the agent
          </span>
        ) : null}
      </div>
      <Input
        // Remounts when the saved value changes, so an undo shows in the field.
        key={`name:${marker.id}:${marker.name}`}
        size="compact"
        aria-label="Marker name"
        placeholder="Name"
        defaultValue={marker.name}
        readOnly={onChange === undefined}
        autoFocus={props.autoFocus === true}
        onBlur={(event) => {
          if (event.currentTarget.value !== marker.name)
            change({ name: event.currentTarget.value });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <Textarea
        key={`note:${marker.id}:${marker.note}`}
        size="sm"
        rows={3}
        aria-label="Marker note"
        placeholder="Note for yourself or the agent"
        defaultValue={marker.note}
        readOnly={onChange === undefined}
        onBlur={(event) => {
          if (event.currentTarget.value !== marker.note)
            change({ note: event.currentTarget.value });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.blur();
        }}
      />
      {onChange ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <div role="radiogroup" aria-label="Marker colour" className="flex items-center gap-1">
            {PREMIERE_MARKER_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={marker.color === color}
                aria-label={MARKER_COLOR_LABELS[color] ?? color}
                onClick={() => change({ color })}
                className={cn(
                  "size-4 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  markerFill(color),
                  marker.color === color && "ring-2 ring-foreground/70 ring-inset",
                )}
              />
            ))}
          </div>
          <span className="ml-auto flex items-center gap-1">
            <Toggle
              size="xs"
              pressed={marker.resolved}
              onPressedChange={(resolved) => change({ resolved })}
            >
              <CheckIcon />
              Resolved
            </Toggle>
            {props.onRemove ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Delete marker"
                onClick={props.onRemove}
              >
                <Trash2Icon />
              </Button>
            ) : null}
          </span>
        </div>
      ) : marker.resolved ? (
        <span className="flex items-center gap-1 text-muted-foreground">
          <CheckIcon className="size-3" /> Resolved
        </span>
      ) : null}
    </div>
  );
}
