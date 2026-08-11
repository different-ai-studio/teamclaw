import { describe, expect, it } from "vitest";

import {
  feedTailStartIndex,
  isFeedNearBottom,
  shouldAutoScrollFeed,
  shouldAutoScrollForNewFeedItem,
  shouldLoadOlderOnStartReached,
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

describe("feed growth direction", () => {
  it("reports where the appended run starts", () => {
    expect(feedTailStartIndex(["a", "b"], ["a", "b", "c", "d"])).toBe(2);
  });

  it("reports no growth when a page was prepended", () => {
    expect(feedTailStartIndex(["c", "d"], ["a", "b", "c", "d"])).toBe(-1);
  });

  it("reports no growth when the feed was reloaded out from under it", () => {
    expect(feedTailStartIndex(["a", "b"], ["x", "y", "z"])).toBe(-1);
  });

  it("reports no growth on the first render", () => {
    expect(feedTailStartIndex([], ["a", "b"])).toBe(-1);
  });

  it("handles a prepend and an append landing together", () => {
    expect(feedTailStartIndex(["c"], ["a", "b", "c", "d"])).toBe(3);
  });
});

describe("back-scroll trigger", () => {
  it("pulls the next page once the user has scrolled up", () => {
    expect(
      shouldLoadOlderOnStartReached({
        canLoadOlder: true,
        isLoadingOlder: false,
        wasNearBottom: false,
      }),
    ).toBe(true);
  });

  it("stays off while the feed is still pinned to the newest message", () => {
    expect(
      shouldLoadOlderOnStartReached({
        canLoadOlder: true,
        isLoadingOlder: false,
        wasNearBottom: true,
      }),
    ).toBe(false);
  });

  it("does not stack a second request on the one in flight", () => {
    expect(
      shouldLoadOlderOnStartReached({
        canLoadOlder: true,
        isLoadingOlder: true,
        wasNearBottom: false,
      }),
    ).toBe(false);
  });

  it("stops at the start of the session", () => {
    expect(
      shouldLoadOlderOnStartReached({
        canLoadOlder: false,
        isLoadingOlder: false,
        wasNearBottom: false,
      }),
    ).toBe(false);
  });
});
