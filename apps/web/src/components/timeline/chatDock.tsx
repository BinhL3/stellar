import { createContext } from "react";

/**
 * The thread's chat lives in one element that is moved, never remounted, between the chat column
 * and the timeline dock's Chat panel. React renders into it through a portal, so the draft, the
 * scroll and a streaming turn survive the move.
 */
export interface ChatHost {
  readonly element: HTMLElement;
  /** Puts the chat in `slot` until the returned cleanup; the latest attached slot holds it. */
  readonly attach: (slot: HTMLElement) => () => void;
}

type Movable = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };

export function createChatHost(): ChatHost {
  const element = document.createElement("div");
  element.className = "flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden";
  // The terminal drawer sizes itself from the column it sits in.
  element.setAttribute("data-chat-column", "");
  const slots: Array<HTMLElement> = [];
  let scrolled = new Map<Element, number>();

  // Detaching an element drops its descendants' scroll offsets; they are put back after a move.
  const rememberScroll = () => {
    if (!element.isConnected) return;
    scrolled = new Map();
    for (const node of element.querySelectorAll("*")) {
      if (node.scrollTop > 0) scrolled.set(node, node.scrollTop);
    }
  };
  const place = () => {
    const slot: Movable | undefined = slots.at(-1);
    if (element.parentElement === slot) return;
    rememberScroll();
    if (slot === undefined) {
      element.remove();
      return;
    }
    // A state-preserving move where the browser has one; both ends must be in the document.
    if (slot.moveBefore && slot.isConnected && element.isConnected) slot.moveBefore(element, null);
    else slot.append(element);
    for (const [node, top] of scrolled) {
      if (element.contains(node)) node.scrollTop = top;
    }
  };

  return {
    element,
    attach: (slot) => {
      slots.push(slot);
      place();
      return () => {
        const index = slots.lastIndexOf(slot);
        if (index !== -1) slots.splice(index, 1);
        place();
      };
    },
  };
}

/** Present inside a thread's view; `docked` says the dock, not the chat column, shows the chat. */
export interface ChatDock {
  readonly host: ChatHost;
  readonly docked: boolean;
}

export const ChatDockContext = createContext<ChatDock | null>(null);

/** Where the chat shows: an empty box the chat element is moved into. */
export function ChatSlot(props: { readonly host: ChatHost; readonly docked?: boolean }) {
  const { host } = props;
  return (
    <div
      ref={(slot) => (slot === null ? undefined : host.attach(slot))}
      className="flex size-full min-h-0 min-w-0 flex-1 flex-col"
      data-chat-docked={props.docked ? "" : undefined}
    />
  );
}
