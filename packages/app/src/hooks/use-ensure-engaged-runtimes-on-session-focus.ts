import * as React from 'react'
import { ensureAgentRuntimesForSession } from '@/lib/teamclaw/ensure-agent-runtime'
import type { EngagedAgentUiEntry } from '@/hooks/use-engaged-agent-ui-states'
import { shouldSkipThrottledRuntimeEnsure, resetRuntimeEnsureThrottle } from '@/lib/teamclaw/runtime-ensure-scheduler'
import { useActorPresenceStore } from '@/stores/actor-presence-store'

/** Agents that may recover via runtimeStart (excludes stale and LWT-offline). */
export function agentIdsNeedingRecoverableRuntimeWake(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
  presenceByActor: Record<string, { online: boolean } | undefined>,
): string[] {
  return entries
    .filter((e) => {
      if (e.uiState === 'stale' || e.uiState === 'ready') return false
      if (e.uiState === 'connecting') return true
      if (e.uiState === 'offline') {
        return presenceByActor[e.agent.id]?.online !== false
      }
      return false
    })
    .map((e) => e.agent.id)
}

/** Agents whose pill is not ready — runtimeStart can help (not stale rebind). */
export function agentIdsNeedingRuntimeWake(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
): string[] {
  return entries
    .filter((e) => e.uiState === 'connecting' || e.uiState === 'offline')
    .map((e) => e.agent.id)
}

export function hasConnectingEngagedAgent(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
): boolean {
  return entries.some((e) => e.uiState === 'connecting')
}

/** Offline pills that may recover (transport glitch), excluding LWT-offline agents. */
export function hasRecoverableOfflineEngagedAgent(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
  presenceByActor: Record<string, { online: boolean } | undefined>,
): boolean {
  return entries.some((e) => {
    if (e.uiState !== 'offline') return false
    return presenceByActor[e.agent.id]?.online !== false
  })
}

export function hasRecoverableNonReadyAgent(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
  presenceByActor: Record<string, { online: boolean } | undefined>,
): boolean {
  return (
    hasConnectingEngagedAgent(entries) ||
    hasRecoverableOfflineEngagedAgent(entries, presenceByActor)
  )
}

const STALE_RUNTIME_RETRY_MS = 15_000

export function useEnsureEngagedRuntimesOnSessionFocus(args: {
  sessionId: string | null
  teamId: string | null
  engagedUiEntries: ReadonlyArray<EngagedAgentUiEntry>
}): void {
  const presenceByActor = useActorPresenceStore((s) => s.byActorId)
  const prevSessionIdRef = React.useRef<string | null>(null)
  const engagedUiEntriesRef = React.useRef(args.engagedUiEntries)
  engagedUiEntriesRef.current = args.engagedUiEntries

  const engagedSignature = React.useMemo(
    () =>
      args.engagedUiEntries
        .map((e) => `${e.agent.id}:${e.uiState}`)
        .sort()
        .join('|'),
    [args.engagedUiEntries],
  )

  const presenceSignature = React.useMemo(
    () =>
      args.engagedUiEntries
        .map((a) => `${a.agent.id}:${presenceByActor[a.agent.id]?.online ?? 'u'}`)
        .sort()
        .join('|'),
    [args.engagedUiEntries, presenceByActor],
  )

  const tryEnsure = React.useCallback(
    (reason: string) => {
      const sessionId = args.sessionId?.trim() || null
      const teamId = args.teamId?.trim() || null
      if (!sessionId || !teamId) return

      const agentActorIds = agentIdsNeedingRecoverableRuntimeWake(
        engagedUiEntriesRef.current,
        useActorPresenceStore.getState().byActorId,
      )
      if (agentActorIds.length === 0) return
      if (shouldSkipThrottledRuntimeEnsure(sessionId, agentActorIds)) return

      void ensureAgentRuntimesForSession({
        sessionId,
        teamId,
        agentActorIds,
        reason,
      })
    },
    [args.sessionId, args.teamId],
  )

  React.useEffect(() => {
    const sessionId = args.sessionId?.trim() || null
    const focusChanged = prevSessionIdRef.current !== sessionId
    if (focusChanged) {
      resetRuntimeEnsureThrottle()
    }
    prevSessionIdRef.current = sessionId

    if (!sessionId || !args.teamId?.trim()) return

    tryEnsure(focusChanged ? 'session_focus' : 'session_runtime_wake')
  }, [args.sessionId, args.teamId, engagedSignature, tryEnsure])

  React.useEffect(() => {
    const sessionId = args.sessionId?.trim() || null
    const teamId = args.teamId?.trim() || null
    if (!sessionId || !teamId) return
    if (!hasRecoverableNonReadyAgent(args.engagedUiEntries, presenceByActor)) return

    const timer = window.setInterval(() => {
      tryEnsure('session_runtime_retry')
    }, STALE_RUNTIME_RETRY_MS)

    return () => window.clearInterval(timer)
  }, [args.sessionId, args.teamId, engagedSignature, presenceSignature, tryEnsure, args.engagedUiEntries, presenceByActor])
}
