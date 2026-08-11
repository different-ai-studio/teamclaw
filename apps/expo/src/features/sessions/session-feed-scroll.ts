export type FeedScrollMetrics = {
  contentHeight: number;
  offsetY: number;
  viewportHeight: number;
};

export function isFeedNearBottom(
  metrics: FeedScrollMetrics,
  thresholdPx = 96,
): boolean {
  const distanceFromBottom =
    metrics.contentHeight - (metrics.offsetY + metrics.viewportHeight);
  return distanceFromBottom <= thresholdPx;
}

export function shouldAutoScrollFeed(input: {
  isInitialLayout: boolean;
  wasNearBottom: boolean;
}): boolean {
  return input.isInitialLayout || input.wasNearBottom;
}

export function shouldAutoScrollForNewFeedItem(input: {
  isOwnOutgoingMessage: boolean;
  wasNearBottom: boolean;
}): boolean {
  return input.wasNearBottom || input.isOwnOutgoingMessage;
}

/**
 * Index of the first item appended after the previous tail, or -1 when the feed
 * did not grow at the end.
 *
 * The feed used to grow in one direction only, so "longer than last render"
 * meant "a message arrived". Back-scroll prepends, which is also longer — and
 * comparing lengths would read a prepended page as new arrivals and yank the
 * view to the bottom, away from the history the user just asked for.
 *
 * A tail that is no longer in the feed at all (a reload, a delete) counts as no
 * growth: there is nothing to follow.
 */
export function feedTailStartIndex(
  prevKeys: readonly string[],
  nextKeys: readonly string[],
): number {
  if (prevKeys.length === 0) return -1;
  const previousTail = prevKeys[prevKeys.length - 1];
  const idx = nextKeys.lastIndexOf(previousTail);
  if (idx < 0 || idx === nextKeys.length - 1) return -1;
  return idx + 1;
}

/**
 * Whether reaching the top of the feed should pull the next page of history.
 *
 * `wasNearBottom` is what keeps this off the initial layout: a list mounts at
 * offset 0, which *is* the start, and would otherwise fetch an older page
 * before the user has looked at the newest one. The feed opens pinned to the
 * bottom, so only a deliberate scroll up can clear the flag.
 */
export function shouldLoadOlderOnStartReached(input: {
  canLoadOlder: boolean;
  isLoadingOlder: boolean;
  wasNearBottom: boolean;
}): boolean {
  return input.canLoadOlder && !input.isLoadingOlder && !input.wasNearBottom;
}
