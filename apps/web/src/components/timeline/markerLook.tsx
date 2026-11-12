import type { PlacedMarker } from "@t3tools/timeline/markers";
import type { MarkerColor } from "@t3tools/timeline/otio";

import { cn } from "~/lib/utils";

/** OTIO has three colours Premiere lacks; each shows as its nearest of Premiere's eight. */
const FILL: Record<MarkerColor, string> = {
  GREEN: "bg-marker-green",
  RED: "bg-marker-red",
  PURPLE: "bg-marker-purple",
  ORANGE: "bg-marker-orange",
  YELLOW: "bg-marker-yellow",
  WHITE: "bg-marker-white",
  BLUE: "bg-marker-blue",
  CYAN: "bg-marker-cyan",
  PINK: "bg-marker-red",
  MAGENTA: "bg-marker-purple",
  BLACK: "bg-marker-white",
};

export const markerFill = (color: MarkerColor) => FILL[color];

export const MARKER_COLOR_LABELS: Partial<Record<MarkerColor, string>> = {
  GREEN: "Green",
  RED: "Red",
  PURPLE: "Purple",
  ORANGE: "Orange",
  YELLOW: "Yellow",
  WHITE: "White",
  BLUE: "Blue",
  CYAN: "Cyan",
};

export const markerTitle = (marker: Pick<PlacedMarker, "name" | "note">) =>
  marker.name || marker.note.split("\n")[0] || "Marker";

/**
 * A marker's mark: a pennant for one the user made, a diamond for one an agent made, so whose
 * note it is reads before its colour does. A resolved marker fades.
 */
export function MarkerGlyph(props: {
  readonly marker: Pick<PlacedMarker, "color" | "author" | "resolved">;
  readonly className?: string;
}) {
  const { marker } = props;
  return (
    <span
      aria-hidden
      className={cn(
        "block h-3 w-2.5 shrink-0",
        markerFill(marker.color),
        marker.author === "agent"
          ? "[clip-path:polygon(50%_0,100%_50%,50%_100%,0_50%)]"
          : "[clip-path:polygon(0_0,100%_0,100%_62%,50%_100%,0_62%)]",
        marker.resolved && "opacity-40",
        props.className,
      )}
    />
  );
}
