import { RuntimeLifecycle } from '@/lib/proto/amux_pb'
import { resolveRuntimeStateEntryForAgent } from '@/lib/runtime-state-resolve'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'

export const RUNTIME_ENSURE_MIN_INTERVAL_MS = 3_000

/**
 * Wake/recover paths — skip when MQTT retain already shows a live runtime.
 * Bind paths (session_create / outbox_send / mention_pill) always proceed.
 * offline_banner_retry is excluded: user asked to retry despite retain ghosts.
 */
const RUNTIME_ENSURE_WAKE_REASONS = new Set([
  'session_focus',
  'session_runtime_wake',
  'session_runtime_retry',
  'mqtt_reconnect_ensure',
  'session_auto_engage',
])

const lastEnsureRef: { key: string; at: number } = { key: '', at: 0 }

export function runtimeEnsureKey(sessionId: string, agentActorIds: string[]): string {
  return `${sessionId}::${agentActorIds.slice().sort().join(',')}`
}

export function isRuntimeEnsureWakeReason(reason: string): boolean {
  return RUNTIME_ENSURE_WAKE_REASONS.has(reason)
}

/** True when every agent already has an ACTIVE runtime retain with models. */
export function agentsHaveLiveRuntimeModels(agentActorIds: string[]): boolean {
  if (agentActorIds.length === 0) return false
  const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId
  return agentActorIds.every((agentActorId) => {
    const entry = resolveRuntimeStateEntryForAgent(agentActorId, byRuntimeId)
    return (
      !!entry &&
      entry.info.state === RuntimeLifecycle.ACTIVE &&
      entry.info.availableModels.length > 0
    )
  })
}

/**
 * Skip redundant runtimeStart on focus/reconnect/retry when retains already
 * show live runtimes. Never skip create/send paths — those bind a new session.
 */
export function shouldSkipAlreadyReadyRuntimeEnsure(
  agentActorIds: string[],
  reason: string,
): boolean {
  if (!isRuntimeEnsureWakeReason(reason)) return false
  return agentsHaveLiveRuntimeModels(agentActorIds)
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
