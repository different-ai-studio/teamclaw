import { AgentStatus, RuntimeLifecycle, type RuntimeInfo } from '@/lib/proto/amux_pb'

/** Conversation-area agent pill / send UX states (方案甲). */
export type SessionAgentUiState =
  | 'ready'
  | 'connecting'
  | 'offline'
  | 'stale'
  /**
   * The daemon is up and answering, and it has no models to run — a fresh
   * install with no provider configured. Terminal until the user configures
   * one, so it must not be shown as `connecting` (which implies "wait") or
   * `offline` (which implies "unreachable"). Local agents only: it is derived
   * from the loopback catalog, which cannot see a remote agent.
   */
  | 'unconfigured'
  /**
   * The daemon answered and told us it could not ask the backend for its models
   * — a rejected API key, a binary that will not start. Terminal like
   * `unconfigured`, but a failure rather than a setup gap: pointing the user at
   * "configure a model" for a bad credential is what this exists to stop.
   */
  | 'catalog-error'

/**
 * What this device's loopback catalog says, for the **local agent only**.
 * Mirrors `LocalDaemonCatalogStatus`; `undefined` for remote agents, which have
 * no loopback path and must keep resolving purely from presence + retain.
 */
export type LocalCatalogSnapshot = 'pending' | 'ready' | 'empty' | 'error' | 'unknown'

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
  /**
   * Loopback catalog result. Set for the local agent only — passing it for a
   * remote agent would claim loopback knowledge about another machine.
   */
  localCatalog?: LocalCatalogSnapshot
}): SessionAgentUiState {
  if (input.isStaleBinding) return 'stale'

  const hasModels = input.availableModelCount > 0

  // ── Local agent fast path ────────────────────────────────────────────────
  // Gated on `localReachabilityConfirmed`, which only the local daemon's
  // loopback probe can set. Remote agents never enter this block and fall
  // through to the presence + retain logic below, unchanged.
  if (input.localReachabilityConfirmed === true && input.reachabilityFailed !== true) {
    // The daemon answered over loopback and told us it has models. That is a
    // stronger, fresher signal than an MQTT retain we have not received yet —
    // waiting for `RuntimeLifecycle.ACTIVE` here is what produced the spurious
    // 连接中 on a perfectly healthy local daemon.
    if (hasModels || input.localCatalog === 'ready') return 'ready'
    // Answered, and genuinely has nothing to run. Terminal, not a wait state.
    if (input.localCatalog === 'empty') return 'unconfigured'
    // Answered, and could not find out. Also terminal, but not the user's
    // configuration to fix.
    if (input.localCatalog === 'error') return 'catalog-error'
    // 'pending' / 'unknown': the loopback request is still out or told us
    // nothing. Fall through — a brief connecting is honest here.
  }

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
    // Remote draft: `{actor}/state` carries default-workspace models before any
    // session attachment exists — treat that as ready when the catalog is non-empty.
    if (!input.runtimeInfo && hasModels) {
      return 'ready'
    }
    if (!input.runtimeInfo || state === RuntimeLifecycle.STARTING || !hasModels) {
      return 'connecting'
    }
    return 'offline'
  }

  return 'connecting'
}

// ────────────────────────────────────────────────────────────────────────────
// Agent pill status dot
// ────────────────────────────────────────────────────────────────────────────

export type AgentPillDot = { color: string; pulse: boolean }

/** Connected = green. Starting = yellow. Error = red. Stopped/unknown = gray. */
export function dotClassesForRuntimeInfo(info: RuntimeInfo | undefined): AgentPillDot {
  if (!info) return { color: 'bg-muted-foreground/40', pulse: false }
  switch (info.state) {
    case RuntimeLifecycle.FAILED:
      return { color: 'bg-red-500', pulse: false }
    case RuntimeLifecycle.STARTING:
      return { color: 'bg-amber-400', pulse: false }
    case RuntimeLifecycle.ACTIVE:
      if (info.status === AgentStatus.ERROR) {
        return { color: 'bg-red-500', pulse: false }
      }
      return { color: 'bg-emerald-500', pulse: false }
    case RuntimeLifecycle.STOPPED:
    case RuntimeLifecycle.UNKNOWN:
    default:
      return { color: 'bg-muted-foreground/40', pulse: false }
  }
}

export function dotClassesForUiState(uiState: SessionAgentUiState): AgentPillDot {
  switch (uiState) {
    case 'ready':
      return { color: 'bg-emerald-500', pulse: false }
    case 'connecting':
      return { color: 'bg-amber-400', pulse: true }
    case 'unconfigured':
      // Amber like connecting — the daemon is up; this is a setup gap, not a
      // failure — but steady, because nothing is in progress.
      return { color: 'bg-amber-400', pulse: false }
    case 'catalog-error':
      // Red, unlike unconfigured's amber: something is broken, not merely unset.
      return { color: 'bg-red-500', pulse: false }
    case 'stale':
      return { color: 'bg-red-500', pulse: false }
    case 'offline':
    default:
      return { color: 'bg-muted-foreground/40', pulse: false }
  }
}

/**
 * THE dot resolver for the agent pill.
 *
 * When a retain exists it is the finer-grained answer (STARTING vs ACTIVE vs
 * FAILED vs ERROR), so it wins. When it does NOT exist, the dot must fall back
 * to `uiState` rather than reporting gray.
 *
 * That fallback is not a nicety — it is the whole point. A **remote** agent
 * only reaches `ready` via the `RuntimeLifecycle.ACTIVE` branch of
 * `resolveSessionAgentUiState`, so a missing retain and `ready` are mutually
 * exclusive for it. The **local** agent has the loopback fast path, which
 * returns `ready` off the catalog alone with no retain in sight — reading the
 * absent retain there painted a gray dot on a pill that was simultaneously
 * showing a model name, no status suffix, and a live model picker.
 */
export function resolveAgentPillDot(
  uiState: SessionAgentUiState,
  runtimeInfo: RuntimeInfo | undefined,
): AgentPillDot {
  if (uiState === 'ready' && runtimeInfo) return dotClassesForRuntimeInfo(runtimeInfo)
  return dotClassesForUiState(uiState)
}

export function toMentionDeliverySnapshot(
  uiState: SessionAgentUiState,
): MentionDeliverySnapshot | null {
  if (uiState === 'ready') return 'ready'
  if (uiState === 'stale') return 'stale'
  // Connecting means the session binding has not landed yet — the send path
  // will spawn/wake. Do not freeze that as "offline" in message metadata.
  if (uiState === 'connecting') return null
  // `unconfigured` is reachable but cannot run a prompt — for delivery purposes
  // that is indistinguishable from offline.
  if (uiState === 'offline' || uiState === 'unconfigured') {
    return 'offline'
  }
  return null
}
