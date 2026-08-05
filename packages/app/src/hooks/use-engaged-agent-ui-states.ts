import * as React from 'react'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'
import { resolveAgentAvailableModels } from '@/lib/agent-available-models'
import { resolveAgentCatalogModels } from '@/lib/agent-model-fallback'
import {
  probeAgentReachability,
  type AgentReachability,
} from '@/lib/agent-reachability-probe'
import { mergeAgentDevicePresence } from '@/lib/agent-device-reachability'
import { resolveRuntimeStateEntryForAgent } from '@/lib/runtime-state-resolve'
import {
  SESSION_AGENT_CONNECTING_TIMEOUT_MS,
  resolveSessionAgentUiState,
  type SessionAgentUiState,
} from '@/lib/session-agent-ui-state'
import {
  getKnownLocalDaemonActorId,
  isSupersededLocalAgent,
  noteLocalDaemonActorId,
} from '@/lib/local-daemon-identity'
import { resolveEngagedAgentStaleBinding } from '@/lib/session-agent-stale-binding'
import { RuntimeLifecycle } from '@/lib/proto/amux_pb'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import {
  resolveSessionAttachmentEntry,
  useRuntimeStateStore,
  type ActorDefaultCatalogEntry,
  type RuntimeStateEntry,
} from '@/stores/runtime-state-store'
import {
  ensureLocalDaemonCatalog,
  useLocalDaemonCatalogStore,
  type LocalDaemonCatalogEntry,
} from '@/stores/local-daemon-catalog-store'
import { useWorkspaceStore } from '@/stores/workspace'
import { getLocalDaemonActorId } from '@/lib/daemon-agent-admin'
import {
  AGENT_REACHABILITY_PROBE_RETRY_MS,
  LOCAL_AGENT_READY_PROBE_INTERVAL_MS,
  LOCAL_CATALOG_POLL_INTERVAL_MS,
} from '@/lib/session-agent-probe'

export type EngagedAgentUiEntry = {
  agent: AttachedAgent
  uiState: SessionAgentUiState
}

const EMPTY_ACTIVE_STREAMING_AGENT_IDS = new Set<string>()

/**
 * Pill UI must not hop to another session's live retain. Without a session
 * binding (or before that spawn's retain exists), show connecting — otherwise
 * quick-create flashes ready → connecting → ready while runtimeStart seeds.
 */
function resolveUiSessionRuntimeEntry(
  agentId: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  dbRuntimeId: string | null | undefined,
): RuntimeStateEntry | undefined {
  const trimmedAgent = agentId.trim()
  const dbId = dbRuntimeId?.trim() ?? ''
  if (!trimmedAgent || !dbId) return undefined

  const attached = resolveSessionAttachmentEntry(trimmedAgent, dbId, byRuntimeId)
  return attached
}

/**
 * Any ACTIVE attachment this actor holds, with a model catalog.
 */
function resolveActorLiveRuntimeEntry(
  agentId: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): RuntimeStateEntry | undefined {
  let best: RuntimeStateEntry | undefined
  for (const entry of Object.values(byRuntimeId)) {
    if (entry.daemonActorId !== agentId) continue
    if (entry.info.state !== RuntimeLifecycle.ACTIVE) continue
    if (resolveAgentAvailableModels(entry.info).length === 0) continue
    if (!best || entry.lastUpdated > best.lastUpdated) best = entry
  }
  return best
}

/**
 * Runtime entry driving the pill for this session.
 *
 * A session binding wins outright. Without one — a draft chat, or a session
 * this daemon has not attached yet — a **remote** agent falls back to its own
 * actor-level state: "that machine is online and has models" is a device fact,
 * not a session one, and withholding it pinned the pill at Connecting until the
 * first send attached a runtime. Local agents keep the loopback path instead.
 */
function resolveProvisionalRuntimeEntry(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): RuntimeStateEntry | undefined {
  const agentId = agent.id.trim()
  const dbRuntimeId = agentToRuntimeId.get(agent.id)
  const sessionBound = resolveUiSessionRuntimeEntry(agent.id, byRuntimeId, dbRuntimeId)
  if (sessionBound) return sessionBound

  if (dbRuntimeId?.trim()) return undefined
  const localId = getKnownLocalDaemonActorId()
  if (localId && agentId === localId) return undefined

  return resolveActorLiveRuntimeEntry(agentId, byRuntimeId)
}

function resolveStaleBinding(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  presenceByActor: Record<string, { online: boolean } | undefined>,
): boolean {
  const localId = getKnownLocalDaemonActorId()
  const dbRuntimeId = agentToRuntimeId.get(agent.id)
  // Stale detection may use global hop — superseded local ghost vs new local.
  const agentEntry = resolveRuntimeStateEntryForAgent(agent.id, byRuntimeId, dbRuntimeId)
  const localEntry = localId
    ? resolveRuntimeStateEntryForAgent(localId, byRuntimeId)
    : undefined
  return resolveEngagedAgentStaleBinding({
    agentId: agent.id,
    localDaemonActorId: localId,
    presenceOnline: presenceByActor[agent.id]?.online,
    agentRuntimeInfo: agentEntry?.info,
    agentAvailableModelCount: resolveAgentAvailableModels(agentEntry?.info).length,
    localRuntimeInfo: localEntry?.info,
    localAvailableModelCount: resolveAgentAvailableModels(localEntry?.info).length,
  })
}

function computeProvisionalState(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  presenceByActor: Record<string, { online: boolean } | undefined>,
  connectingSinceByAgent: Record<string, number>,
  reachabilityByAgent: Record<string, AgentReachability>,
  activeStreamingAgentIds: ReadonlySet<string>,
  localCatalog: LocalDaemonCatalogEntry | undefined,
  defaultCatalogByActorId: Record<string, ActorDefaultCatalogEntry>,
  now: number,
): SessionAgentUiState {
  const dbRuntimeId = agentToRuntimeId.get(agent.id)
  const entry = resolveProvisionalRuntimeEntry(agent, agentToRuntimeId, byRuntimeId)
  const runtimeInfo = entry?.info
  const localId = getKnownLocalDaemonActorId()
  const isLocalAgent = !!localId && agent.id === localId
  const availableModelCount = resolveAgentCatalogModels({
    agentId: agent.id,
    localDaemonActorId: localId,
    sessionId: dbRuntimeId,
    byRuntimeId,
    runtimeInfo,
    localWorkspaceCatalogModels: localCatalog?.models,
    remoteDefaultCatalogModels: defaultCatalogByActorId[agent.id]?.models,
  }).length
  const since = connectingSinceByAgent[agent.id]
  const connectingTimedOut =
    since !== undefined && now - since >= SESSION_AGENT_CONNECTING_TIMEOUT_MS
  const reachability = reachabilityByAgent[agent.id]
  const reachabilityFailed = reachability === 'unreachable'
  const mqttOnline = presenceByActor[agent.id]?.online
  const devicePresence = mergeAgentDevicePresence({
    mqttOnline,
    isLocalDaemon: isLocalAgent,
    localHttpOk:
      isLocalAgent && reachability === 'reachable'
        ? true
        : isLocalAgent && reachability === 'unreachable'
          ? false
          : null,
  })
  const presenceOnline =
    devicePresence === 'online' ? true : devicePresence === 'offline' ? false : undefined

  // Loopback knowledge is about THIS machine — attaching it to a remote agent
  // would let one device's catalog decide another device's readiness.
  const localCatalogSnapshot = isLocalAgent ? localCatalog?.status : undefined

  return resolveSessionAgentUiState({
    presenceOnline,
    runtimeInfo,
    availableModelCount,
    isStaleBinding: resolveStaleBinding(agent, agentToRuntimeId, byRuntimeId, presenceByActor),
    connectingTimedOut,
    reachabilityFailed,
    localReachabilityConfirmed: isLocalAgent && reachability === 'reachable',
    activeStreamConfirmed: activeStreamingAgentIds.has(agent.id),
    localCatalog: localCatalogSnapshot,
  })
}

function shouldProbeAgent(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  presenceByActor: Record<string, { online: boolean } | undefined>,
  connectingSinceByAgent: Record<string, number>,
  reachabilityByAgent: Record<string, AgentReachability>,
  lastProbeAtByAgent: Record<string, number>,
  localDaemonActorId: string | null,
  activeStreamingAgentIds: ReadonlySet<string>,
  localCatalog: LocalDaemonCatalogEntry | undefined,
  defaultCatalogByActorId: Record<string, ActorDefaultCatalogEntry>,
  now: number,
): boolean {
  if (isSupersededLocalAgent(agent.id)) return false

  const state = computeProvisionalState(
    agent,
    agentToRuntimeId,
    byRuntimeId,
    presenceByActor,
    connectingSinceByAgent,
    reachabilityByAgent,
    activeStreamingAgentIds,
    localCatalog,
    defaultCatalogByActorId,
    now,
  )
  if (state === 'stale') return false

  const localId = localDaemonActorId?.trim() || null
  const isLocalAgent = !!localId && agent.id === localId

  if (state === 'ready') {
    if (!isLocalAgent) return false
    const lastProbeAt = lastProbeAtByAgent[agent.id] ?? 0
    return now - lastProbeAt >= LOCAL_AGENT_READY_PROBE_INTERVAL_MS
  }

  const reachability = reachabilityByAgent[agent.id]
  if (reachability === 'pending') return false
  if (reachability === 'reachable') return false
  if (reachability === 'unreachable') {
    const lastProbeAt = lastProbeAtByAgent[agent.id] ?? 0
    return now - lastProbeAt >= AGENT_REACHABILITY_PROBE_RETRY_MS
  }

  if (state === 'connecting') return true
  if (state === 'offline' && isLocalAgent) {
    const lastProbeAt = lastProbeAtByAgent[agent.id] ?? 0
    return now - lastProbeAt >= AGENT_REACHABILITY_PROBE_RETRY_MS
  }
  if (state === 'offline' && presenceByActor[agent.id]?.online === true) return true
  return false
}

export function useEngagedAgentUiStates(
  engagedAgents: AttachedAgent[],
  agentToRuntimeId: Map<string, string>,
  activeStreamingAgentIds: ReadonlySet<string> = EMPTY_ACTIVE_STREAMING_AGENT_IDS,
): EngagedAgentUiEntry[] {
  const byRuntimeId = useRuntimeStateStore((s) => s.byRuntimeId)
  const defaultCatalogByActorId = useRuntimeStateStore((s) => s.defaultCatalogByActorId)
  const presenceByActor = useActorPresenceStore((s) => s.byActorId)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)?.trim() || ''
  const localCatalog = useLocalDaemonCatalogStore((s) =>
    workspacePath ? s.byWorkspacePath[workspacePath] : undefined,
  )
  const [connectingSinceByAgent, setConnectingSinceByAgent] = React.useState<
    Record<string, number>
  >({})
  const [reachabilityByAgent, setReachabilityByAgent] = React.useState<
    Record<string, AgentReachability>
  >({})
  const lastProbeAtByAgentRef = React.useRef<Record<string, number>>({})
  const engagedAgentsRef = React.useRef(engagedAgents)
  engagedAgentsRef.current = engagedAgents
  const [, tick] = React.useReducer((x: number) => x + 1, 0)
  const [, probeScheduleTick] = React.useReducer((x: number) => x + 1, 0)

  React.useEffect(() => {
    let cancelled = false
    const load = async () => {
      const id = await getLocalDaemonActorId()
      if (cancelled) return
      noteLocalDaemonActorId(id)
    }
    void load()
    const interval = setInterval(() => void load(), 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  React.useEffect(() => {
    const interval = setInterval(() => tick(), 1_000)
    return () => clearInterval(interval)
  }, [])

  // Keep this device's loopback catalog warm.
  //
  // Deliberately NOT gated on the local agent being engaged yet: on a cold
  // start the pill renders before anything is mentioned, and waiting for
  // engagement would put the catalog fetch behind the very render it is meant
  // to unblock — the 连接中 flash this fast path exists to remove. It is one
  // loopback request for the whole device, and the store rate-limits a settled
  // answer to one refresh per 5 minutes, so the standing cost is negligible.
  // Still local-only: this reaches this machine's daemon and no other.
  React.useEffect(() => {
    if (!workspacePath) return
    const run = () => {
      // No local daemon identity has ever been observed on this device — there
      // is nothing on loopback to ask.
      if (!getKnownLocalDaemonActorId()) return
      ensureLocalDaemonCatalog(workspacePath)
    }
    run()
    const interval = setInterval(run, LOCAL_CATALOG_POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [workspacePath])

  React.useEffect(() => {
    const interval = setInterval(
      () => probeScheduleTick(),
      LOCAL_AGENT_READY_PROBE_INTERVAL_MS,
    )
    return () => clearInterval(interval)
  }, [])

  const engagedSignature = React.useMemo(
    () =>
      engagedAgents
        .map((a) => a.id)
        .sort()
        .join(','),
    [engagedAgents],
  )
  const runtimeMapSignature = React.useMemo(
    () =>
      [...agentToRuntimeId.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([agentId, runtimeId]) => `${agentId}:${runtimeId}`)
        .join('|'),
    [agentToRuntimeId],
  )
  const activeStreamingSignature = React.useMemo(
    () => [...activeStreamingAgentIds].sort().join(','),
    [activeStreamingAgentIds],
  )

  const presenceSignature = React.useMemo(
    () =>
      engagedAgents
        .map((a) => `${a.id}:${presenceByActor[a.id]?.online ?? 'u'}`)
        .sort()
        .join('|'),
    [engagedAgents, presenceByActor],
  )

  React.useEffect(() => {
    const now = Date.now()
    const activeIds = new Set(engagedAgents.map((a) => a.id))
    setConnectingSinceByAgent((prev) => {
      const next: Record<string, number> = {}
      let changed = false

      for (const agent of engagedAgents) {
        const provisional = computeProvisionalState(
          agent,
          agentToRuntimeId,
          byRuntimeId,
          presenceByActor,
          prev,
          reachabilityByAgent,
          activeStreamingAgentIds,
          localCatalog,
          defaultCatalogByActorId,
          now,
        )
        if (provisional === 'connecting') {
          next[agent.id] = prev[agent.id] ?? now
          if (prev[agent.id] !== next[agent.id]) changed = true
        }
      }

      for (const id of Object.keys(prev)) {
        if (!activeIds.has(id)) changed = true
      }

      if (!changed && Object.keys(prev).length === Object.keys(next).length) {
        let same = true
        for (const [id, since] of Object.entries(next)) {
          if (prev[id] !== since) {
            same = false
            break
          }
        }
        if (same) return prev
      }
      return next
    })

    setReachabilityByAgent((prev) => {
      const next: Record<string, AgentReachability> = {}
      let changed = false
      for (const agent of engagedAgents) {
        if (prev[agent.id]) {
          next[agent.id] = prev[agent.id]
        }
      }
      for (const id of Object.keys(prev)) {
        if (!activeIds.has(id)) changed = true
      }
      if (!changed && Object.keys(prev).length === Object.keys(next).length) {
        let same = true
        for (const [id, value] of Object.entries(next)) {
          if (prev[id] !== value) {
            same = false
            break
          }
        }
        if (same) return prev
      }
      return next
    })
  }, [
    engagedAgents,
    engagedSignature,
    runtimeMapSignature,
    presenceSignature,
    activeStreamingSignature,
    byRuntimeId,
    agentToRuntimeId,
    reachabilityByAgent,
    connectingSinceByAgent,
    activeStreamingAgentIds,
    localCatalog,
    defaultCatalogByActorId,
  ])

  React.useEffect(() => {
    const now = Date.now()
    const localDaemonActorId = getKnownLocalDaemonActorId()

    for (const agent of engagedAgents) {
      if (
        !shouldProbeAgent(
          agent,
          agentToRuntimeId,
          byRuntimeId,
          presenceByActor,
          connectingSinceByAgent,
          reachabilityByAgent,
          lastProbeAtByAgentRef.current,
          localDaemonActorId,
          activeStreamingAgentIds,
          localCatalog,
          defaultCatalogByActorId,
          now,
        )
      ) {
        continue
      }

      const agentId = agent.id
      setReachabilityByAgent((prev) => {
        if (prev[agentId] === 'pending') return prev
        return { ...prev, [agentId]: 'pending' }
      })
      lastProbeAtByAgentRef.current[agentId] = now

      void probeAgentReachability({
        agentActorId: agentId,
        localDaemonActorId,
      }).then((result) => {
        if (!engagedAgentsRef.current.some((row) => row.id === agentId)) return
        setReachabilityByAgent((prev) => ({
          ...prev,
          [agentId]: result,
        }))
      })
    }
  }, [
    engagedAgents,
    engagedSignature,
    runtimeMapSignature,
    presenceSignature,
    byRuntimeId,
    agentToRuntimeId,
    connectingSinceByAgent,
    reachabilityByAgent,
    probeScheduleTick,
    activeStreamingSignature,
    activeStreamingAgentIds,
    localCatalog,
    defaultCatalogByActorId,
  ])

  return React.useMemo(() => {
    const now = Date.now()
    return engagedAgents.map((agent) => ({
      agent,
      uiState: computeProvisionalState(
        agent,
        agentToRuntimeId,
        byRuntimeId,
        presenceByActor,
        connectingSinceByAgent,
        reachabilityByAgent,
        activeStreamingAgentIds,
        localCatalog,
        defaultCatalogByActorId,
        now,
      ),
    }))
  }, [
    engagedAgents,
    engagedSignature,
    runtimeMapSignature,
    presenceSignature,
    activeStreamingSignature,
    connectingSinceByAgent,
    reachabilityByAgent,
    byRuntimeId,
    agentToRuntimeId,
    activeStreamingAgentIds,
    localCatalog,
    defaultCatalogByActorId,
    tick,
  ])
}

/** True when any engaged agent is not ready (offline, connecting, or stale). */
export function hasAnyNonReadyEngaged(entries: EngagedAgentUiEntry[]): boolean {
  return entries.some((e) => e.uiState !== 'ready')
}
