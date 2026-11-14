import type { ComponentProps } from "react";

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

export const Bay = { Toolbar, Label, Mark, Item, ItemButton };
