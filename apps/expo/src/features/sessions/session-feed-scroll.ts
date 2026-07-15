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
