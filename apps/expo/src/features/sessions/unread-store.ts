type Listener = (count: number) => void;

let count = 0;
const listeners = new Set<Listener>();

/**
 * Process-local unread session counter. Written by the Sessions
 * controller whenever a list load resolves (so it stays in sync with
 * the rows the user sees), read by the tabs layout to drive the
 * Sessions tab's badge. Lives outside React state so cross-tree
 * subscribers don't have to share a context.
 */
export function setUnreadSessionCount(next: number) {
  if (next === count) return;
  count = next;
  for (const listener of listeners) listener(count);
}

export function getUnreadSessionCount(): number {
  return count;
}

export function subscribeUnreadSessionCount(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
