import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  findChatMessageElement,
  flashChatMessage,
  jumpToMessageById,
  requestChatScrollToMessage,
  scrollChatMessageIntoView,
  CHAT_SCROLL_TO_MESSAGE_EVENT,
} from "@/lib/chat-scroll-to-message";

describe("chat-scroll-to-message", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scrolls within the chat messages container instead of the document", () => {
    document.body.innerHTML = `
      <div data-chat-messages style="height: 200px; overflow: auto;">
        <div data-testid="chat-message" data-message-id="target">msg</div>
      </div>
    `;

    const container = document.querySelector("[data-chat-messages]") as HTMLElement;
    const message = findChatMessageElement("target")!;
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo as typeof container.scrollTo;

    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      top: 0,
      left: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(message, "getBoundingClientRect").mockReturnValue({
      top: 300,
      left: 0,
      right: 200,
      bottom: 340,
      width: 200,
      height: 40,
      x: 0,
      y: 300,
      toJSON: () => ({}),
    });
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      writable: true,
      value: 100,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 200,
    });

    scrollChatMessageIntoView(message, { behavior: "instant" });

    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: expect.any(Number), behavior: "instant" }),
    );
  });

  it("dispatches scroll request when target message is not mounted yet", () => {
    const handler = vi.fn();
    window.addEventListener(CHAT_SCROLL_TO_MESSAGE_EVENT, handler);

    expect(jumpToMessageById("missing-id")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    window.removeEventListener(CHAT_SCROLL_TO_MESSAGE_EVENT, handler);
  });

  it("flashes the target message element", () => {
    document.body.innerHTML =
      '<div data-testid="chat-message" data-message-id="m1">x</div>';
    const message = findChatMessageElement("m1")!;
    flashChatMessage(message);
    expect(message.classList.contains("agent-reply-quote-flash")).toBe(true);
  });

  it("requestChatScrollToMessage ignores empty ids", () => {
    const handler = vi.fn();
    window.addEventListener(CHAT_SCROLL_TO_MESSAGE_EVENT, handler);
    requestChatScrollToMessage("   ");
    expect(handler).not.toHaveBeenCalled();
    window.removeEventListener(CHAT_SCROLL_TO_MESSAGE_EVENT, handler);
  });
});
