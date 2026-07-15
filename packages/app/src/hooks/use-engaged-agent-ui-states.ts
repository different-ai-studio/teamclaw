import * as React from 'react'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'
import { resolveAgentAvailableModels } from '@/lib/agent-available-models'
import {
  probeAgentReachability,
  type AgentReachability,
} from '@/lib/agent-reachability-probe'
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
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { useRuntimeStateStore, type RuntimeStateEntry } from '@/stores/runtime-state-store'
import { getLocalDaemonActorId } from '@/lib/daemon-agent-admin'
import {
  AGENT_REACHABILITY_PROBE_RETRY_MS,
  LOCAL_AGENT_READY_PROBE_INTERVAL_MS,
} from '@/lib/session-agent-probe'

export type EngagedAgentUiEntry = {
  agent: AttachedAgent
  uiState: SessionAgentUiState
}

const EMPTY_ACTIVE_STREAMING_AGENT_IDS = new Set<string>()

function resolveStaleBinding(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  presenceByActor: Record<string, { online: boolean } | undefined>,
): boolean {
  const localId = getKnownLocalDaemonActorId()
  const dbRuntimeId = agentToRuntimeId.get(agent.id)
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
  now: number,
): SessionAgentUiState {
  const dbRuntimeId = agentToRuntimeId.get(agent.id)
  const entry = resolveRuntimeStateEntryForAgent(agent.id, byRuntimeId, dbRuntimeId)
  const runtimeInfo = entry?.info
  const availableModelCount = resolveAgentAvailableModels(runtimeInfo).length
  const presenceOnline = presenceByActor[agent.id]?.online
  const since = connectingSinceByAgent[agent.id]
  const connectingTimedOut =
    since !== undefined && now - since >= SESSION_AGENT_CONNECTING_TIMEOUT_MS
  const reachability = reachabilityByAgent[agent.id]
  const reachabilityFailed = reachability === 'unreachable'
  const localId = getKnownLocalDaemonActorId()
  const isLocalAgent = !!localId && agent.id === localId

  return resolveSessionAgentUiState({
    presenceOnline,
    runtimeInfo,
    availableModelCount,
    isStaleBinding: resolveStaleBinding(agent, agentToRuntimeId, byRuntimeId, presenceByActor),
    connectingTimedOut,
    reachabilityFailed,
    localReachabilityConfirmed: isLocalAgent && reachability === 'reachable',
    activeStreamConfirmed: activeStreamingAgentIds.has(agent.id),
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
  const presenceByActor = useActorPresenceStore((s) => s.byActorId)
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
    tick,
  ])
}

export function countNonReadyEngaged(entries: EngagedAgentUiEntry[]): number {
  return entries.filter((e) => e.uiState !== 'ready').length
}

export function allEngagedNonReady(entries: EngagedAgentUiEntry[]): boolean {
  return entries.length > 0 && entries.every((e) => e.uiState !== 'ready')
}

/** True when any engaged agent is not ready (offline, connecting, or stale). */
export function hasAnyNonReadyEngaged(entries: EngagedAgentUiEntry[]): boolean {
  return entries.some((e) => e.uiState !== 'ready')
}
