import { describe, expect, it } from "vitest";
import { VIRTUAL_MSG_THRESHOLD } from "../MessageList";

/**
 * Virtualization is re-enabled above this threshold (PR #499).
 * Row overlap on sidebar/width changes must still be verified manually:
 * open a >200-message session, toggle sidebar, resize window.
 */
describe("MessageList virtualization gate", () => {
  it("enables virtualization above 200 messages", () => {
    expect(VIRTUAL_MSG_THRESHOLD).toBe(200);
  });
});
