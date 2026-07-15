import { describe, expect, it } from "vitest";

import {
  isFeedNearBottom,
  shouldAutoScrollFeed,
  shouldAutoScrollForNewFeedItem,
} from "../features/sessions/session-feed-scroll";

describe("session feed scroll policy", () => {
  it("treats the viewport as near bottom when within the threshold", () => {
    expect(
      isFeedNearBottom({
        contentHeight: 1400,
        offsetY: 615,
        viewportHeight: 720,
      }),
    ).toBe(true);
  });

  it("detects when the user is reading earlier content", () => {
    expect(
      isFeedNearBottom({
        contentHeight: 2200,
        offsetY: 300,
        viewportHeight: 720,
      }),
    ).toBe(false);
  });

  it("auto-scrolls initial layout and near-bottom updates only", () => {
    expect(shouldAutoScrollFeed({ isInitialLayout: true, wasNearBottom: false })).toBe(true);
    expect(shouldAutoScrollFeed({ isInitialLayout: false, wasNearBottom: true })).toBe(true);
    expect(shouldAutoScrollFeed({ isInitialLayout: false, wasNearBottom: false })).toBe(false);
  });

  it("follows the tail after the user sends a new message", () => {
    expect(
      shouldAutoScrollForNewFeedItem({
        isOwnOutgoingMessage: true,
        wasNearBottom: false,
      }),
    ).toBe(true);
    expect(
      shouldAutoScrollForNewFeedItem({
        isOwnOutgoingMessage: false,
        wasNearBottom: false,
      }),
    ).toBe(false);
  });
});
