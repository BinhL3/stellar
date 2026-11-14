import type { ComponentProps, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

/** A panel's bar. Its edge thins out in dots, like the dock's tab bar, instead of a hairline. */
function Toolbar({
  edge = "bottom",
  className,
  ...props
}: ComponentProps<"div"> & { readonly edge?: "bottom" | "top" }) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 px-2 text-xs",
        edge === "bottom" ? "h-9 dither-edge-b pb-1" : "dither-edge-t pt-1",
        className,
      )}
      {...props}
    />
  );
}

/** Section labels, counts and small metadata: mono capitals. */
function Label({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("bay-label text-muted-foreground", className)} {...props} />;
}

/** The dithered block that marks what is active or waiting on the user. */
function Mark({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      className={cn("block size-1.5 shrink-0 dither-block text-primary", className)}
      {...props}
    />
  );
}

/** A row of a panel's list. The open row lifts a surface step and takes an accent edge. */
function Item({
  selected = false,
  className,
  ...props
}: ComponentProps<"li"> & { readonly selected?: boolean }) {
  return (
    <li
      className={cn(
        "relative rounded-sm",
        selected &&
          "bg-accent/60 before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
        className,
      )}
      {...props}
    />
  );
}

/** The press target of an `Item`: the whole row, with the focus ring inside it. */
function ItemButton({
  selected = false,
  className,
  ...props
}: ComponentProps<"button"> & { readonly selected?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        !selected && "hover:bg-accent/70",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Controls that wait for the pointer: hidden until their `group/bay` panel is hovered or holds
 * focus, and kept on show while one of them is on or open. Touch screens always show them.
 */
function Reveal({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/bay:opacity-100 group-hover/bay:opacity-100 has-data-popup-open:opacity-100 has-data-pressed:opacity-100 pointer-coarse:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/** Short text whose longer explanation waits in a tooltip instead of standing beside it. */
function Hint({
  hint,
  side = "bottom",
  ...props
}: ComponentProps<"span"> & {
  readonly hint: ReactNode;
  readonly side?: "top" | "bottom";
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span {...props} />} />
      <TooltipPopup side={side}>{hint}</TooltipPopup>
    </Tooltip>
  );
}

export const Bay = { Toolbar, Label, Mark, Item, ItemButton, Reveal, Hint };
