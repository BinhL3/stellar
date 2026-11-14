import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { type ChatHost, ChatSlot, createChatHost } from "./chatDock";

function Chat(props: { readonly onMount: () => void }) {
  const { onMount } = props;
  useEffect(() => onMount(), [onMount]);
  return (
    <>
      <div data-testid="messages" style={{ height: 100, overflow: "auto" }}>
        <div style={{ height: 1000 }} />
      </div>
      <textarea aria-label="Draft" />
    </>
  );
}

/** ChatView's shape: the chat column or the dock's Chat panel holds the one chat element. */
function View(props: {
  readonly where: "column" | "dock" | "closed";
  readonly onMount: () => void;
}) {
  const [host] = useState<ChatHost>(createChatHost);
  return (
    <>
      <div data-testid="column">{props.where === "column" ? <ChatSlot host={host} /> : null}</div>
      <div data-testid="dock">
        {props.where === "dock" ? <ChatSlot host={host} docked /> : null}
      </div>
      {createPortal(<Chat onMount={props.onMount} />, host.element)}
    </>
  );
}

describe("chat dock", () => {
  it("moves the chat between the column and the dock without remounting it", async () => {
    const onMount = vi.fn();
    // No links or navigation inside.
    await using screen = await render(<View where="column" onMount={onMount} />, {
      router: false,
    });
    const draft = screen.getByRole("textbox", { name: "Draft" });
    await userEvent.type(draft, "cut the intro");
    const messages = screen.container.querySelector<HTMLElement>("[data-testid=messages]")!;
    messages.scrollTop = 400;

    await screen.rerender(<View where="dock" onMount={onMount} />);
    const dock = screen.container.querySelector("[data-testid=dock]")!;
    expect(dock.contains(messages)).toBe(true);
    expect(dock.querySelector("[data-chat-docked]")?.contains(messages)).toBe(true);
    await expect.element(draft).toHaveValue("cut the intro");
    expect(messages.scrollTop).toBe(400);

    // Closing the Chat panel parks the chat off screen; reopening it brings back the same one.
    await screen.rerender(<View where="closed" onMount={onMount} />);
    expect(messages.isConnected).toBe(false);
    await screen.rerender(<View where="column" onMount={onMount} />);
    const column = screen.container.querySelector("[data-testid=column]")!;
    expect(column.contains(messages)).toBe(true);
    await expect.element(draft).toHaveValue("cut the intro");
    expect(messages.scrollTop).toBe(400);
    expect(onMount).toHaveBeenCalledTimes(1);
  });
});
