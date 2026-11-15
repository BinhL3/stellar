import { createContext, use, type ReactNode } from "react";
import { createPortal } from "react-dom";

const ToolbarSlotContext = createContext<HTMLElement | null>(null);

export const RightPanelToolbarSlot = ToolbarSlotContext.Provider;

/**
 * The active surface's own controls, drawn in the panel's tab bar so they cost no row of their
 * own. A tab bar too narrow to hold them hangs them just below it (see `RightPanelTabs`); the
 * spacer makes room for that row. Outside a panel there is no tab bar, so they keep a row.
 */
export function RightPanelToolbar(props: { readonly children: ReactNode }) {
  const slot = use(ToolbarSlotContext);
  if (slot === null) {
    return <div className="flex h-11 shrink-0 items-center gap-1 px-2">{props.children}</div>;
  }
  return (
    <>
      {createPortal(props.children, slot)}
      <div aria-hidden className="hidden h-11 shrink-0 @max-[52rem]/panel:block" />
    </>
  );
}
