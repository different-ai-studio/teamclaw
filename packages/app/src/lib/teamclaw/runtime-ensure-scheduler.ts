export const RUNTIME_ENSURE_MIN_INTERVAL_MS = 3_000

const lastEnsureRef: { key: string; at: number } = { key: '', at: 0 }

export function runtimeEnsureKey(sessionId: string, agentActorIds: string[]): string {
  return `${sessionId}::${agentActorIds.slice().sort().join(',')}`
}

/** Returns true when a recent runtime-start attempt for the same session+agents should be skipped. */
export function shouldSkipThrottledRuntimeEnsure(sessionId: string, agentActorIds: string[]): boolean {
  const key = runtimeEnsureKey(sessionId, agentActorIds)
  const now = Date.now()
  return lastEnsureRef.key === key && now - lastEnsureRef.at < RUNTIME_ENSURE_MIN_INTERVAL_MS
}

/** Record a runtime-start attempt (call only when startAgentRuntimesAsync is about to run). */
export function recordRuntimeEnsureAttempt(sessionId: string, agentActorIds: string[]): void {
  lastEnsureRef.key = runtimeEnsureKey(sessionId, agentActorIds)
  lastEnsureRef.at = Date.now()
}

export function resetRuntimeEnsureThrottle(): void {
  lastEnsureRef.key = ''
  lastEnsureRef.at = 0
}

/** @internal test helper */
export function resetRuntimeEnsureThrottleForTests(): void {
  resetRuntimeEnsureThrottle()
}
