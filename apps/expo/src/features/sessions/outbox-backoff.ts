export const OUTBOX_MAX_ATTEMPTS = 20;

/**
 * Schedule: 500ms, 1s, 2s, 4s, 8s, 16s, then 30s capped.
 * `attempt` is the post-bump counter — pass 1 for the first failure.
 * Mirrors iOS OutboxSender.backoff.
 */
export function outboxBackoffMs(attempt: number): number {
  const exp = Math.max(0, attempt - 1);
  const base = Math.pow(2, Math.min(exp, 6)) * 500;
  return Math.min(base, 30_000);
}
