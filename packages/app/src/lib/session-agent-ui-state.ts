import { RuntimeLifecycle, type RuntimeInfo } from '@/lib/proto/amux_pb'

/** Conversation-area agent pill / send UX states (方案甲). */
export type SessionAgentUiState = 'ready' | 'connecting' | 'offline' | 'stale'

export type MentionDeliverySnapshot = 'ready' | 'offline' | 'stale'

export const SESSION_AGENT_CONNECTING_TIMEOUT_MS = 10_000

/**
 * Detects MQTT ghost retain for a **prior local** amuxd identity while this
 * machine's daemon already publishes a live runtime under a new id.
 *
 * Callers must gate with `wasEverLocalDaemonIdentity(agentId)` first — this is
 * not a remote-agent reachability signal.
 */
export function isDriftedLocalGhostBinding(input: {
  agentId: string
  localDaemonActorId: string | null
  presenceOnline: boolean | undefined
  agentRuntimeInfo: RuntimeInfo | undefined
  agentAvailableModelCount: number
  localRuntimeInfo: RuntimeInfo | undefined
  localAvailableModelCount: number
}): boolean {
  const localId = input.localDaemonActorId?.trim()
  const agentId = input.agentId.trim()
  if (!localId || agentId === localId) return false
  if (input.presenceOnline !== true) return false

  const agentReady =
    input.agentAvailableModelCount > 0 &&
    input.agentRuntimeInfo?.state === RuntimeLifecycle.ACTIVE
  if (agentReady) return false

  const localReady =
    input.localAvailableModelCount > 0 &&
    input.localRuntimeInfo?.state === RuntimeLifecycle.ACTIVE
  return localReady
}

export function resolveSessionAgentUiState(input: {
  presenceOnline: boolean | undefined
  runtimeInfo: RuntimeInfo | undefined
  availableModelCount: number
  isStaleBinding: boolean
  connectingTimedOut: boolean
  /** Active HTTP/RPC probe failed while still connecting. */
  reachabilityFailed?: boolean
  /** Local daemon HTTP answered while MQTT presence is stale or delayed. */
  localReachabilityConfirmed?: boolean
  /** The current session is receiving a live stream from this agent. */
  activeStreamConfirmed?: boolean
}): SessionAgentUiState {
  if (input.isStaleBinding) return 'stale'

  const hasModels = input.availableModelCount > 0
  const state = input.runtimeInfo?.state
  if (
    state === RuntimeLifecycle.ACTIVE &&
    input.reachabilityFailed !== true &&
    (input.activeStreamConfirmed === true ||
      (hasModels &&
        (input.presenceOnline !== false || input.localReachabilityConfirmed === true)))
  ) {
    return 'ready'
  }

  // Presence (LWT) and active probe failures veto MQTT retain ghosts before ready.
  if (input.presenceOnline === false || input.reachabilityFailed === true) {
    return 'offline'
  }

  if (input.connectingTimedOut) {
    return 'offline'
  }

  if (input.presenceOnline === true) {
    if (!input.runtimeInfo || state === RuntimeLifecycle.STARTING || !hasModels) {
      return 'connecting'
    }
    return 'offline'
  }

  return 'connecting'
}

export function toMentionDeliverySnapshot(
  uiState: SessionAgentUiState,
): MentionDeliverySnapshot | null {
  if (uiState === 'ready') return 'ready'
  if (uiState === 'stale') return 'stale'
  if (uiState === 'offline' || uiState === 'connecting') return 'offline'
  return null
}

export function isNonReadyEngagedState(uiState: SessionAgentUiState): boolean {
  return uiState !== 'ready'
}
