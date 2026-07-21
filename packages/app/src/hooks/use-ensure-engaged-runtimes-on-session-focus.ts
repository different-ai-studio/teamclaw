import * as React from 'react'
import { resolveAgentDevicePresenceSync } from '@/lib/agent-device-reachability'
import { ensureAgentRuntimesForSession } from '@/lib/teamclaw/ensure-agent-runtime'
import type { EngagedAgentUiEntry } from '@/hooks/use-engaged-agent-ui-states'
import {
  agentsHaveLiveRuntimeModels,
  shouldSkipAlreadyReadyRuntimeEnsure,
  shouldSkipThrottledRuntimeEnsure,
  resetRuntimeEnsureThrottle,
} from '@/lib/teamclaw/runtime-ensure-scheduler'
import { useActorPresenceStore } from '@/stores/actor-presence-store'

function isDeviceOfflineForWake(agentId: string): boolean {
  return resolveAgentDevicePresenceSync(agentId) === 'offline'
}

/** Agents that may recover via runtimeStart (excludes stale, ready, live-retain, hard-offline). */
export function agentIdsNeedingRecoverableRuntimeWake(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
  _presenceByActor?: Record<string, { online: boolean } | undefined>,
): string[] {
  return entries
    .filter((e) => {
      if (e.uiState === 'stale' || e.uiState === 'ready') return false
      if (agentsHaveLiveRuntimeModels([e.agent.id])) return false
      if (e.uiState === 'connecting') return true
      if (e.uiState === 'offline') {
        // Shared merge: LWT-offline remote stays out; local stale LWT may still wake.
        return !isDeviceOfflineForWake(e.agent.id)
      }
      return false
    })
    .map((e) => e.agent.id)
}

/** Same-session signature wakes: only connecting (offline recovers on focus / retry). */
export function agentIdsNeedingConnectingWake(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
): string[] {
  return entries
    .filter((e) => {
      if (e.uiState !== 'connecting') return false
      if (agentsHaveLiveRuntimeModels([e.agent.id])) return false
      return true
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

/** Offline pills that may recover (transport glitch), excluding hard-offline agents. */
export function hasRecoverableOfflineEngagedAgent(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
  _presenceByActor?: Record<string, { online: boolean } | undefined>,
): boolean {
  return entries.some((e) => {
    if (e.uiState !== 'offline') return false
    return !isDeviceOfflineForWake(e.agent.id)
  })
}

export function hasRecoverableNonReadyAgent(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
  presenceByActor?: Record<string, { online: boolean } | undefined>,
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
    (reason: string, agentActorIds: string[]) => {
      const sessionId = args.sessionId?.trim() || null
      const teamId = args.teamId?.trim() || null
      if (!sessionId || !teamId) return
      if (agentActorIds.length === 0) return
      if (shouldSkipAlreadyReadyRuntimeEnsure(agentActorIds, reason)) return
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

    const entries = engagedUiEntriesRef.current
    if (focusChanged) {
      tryEnsure('session_focus', agentIdsNeedingRecoverableRuntimeWake(entries, presenceByActor))
      return
    }
    // Same session: only wake newly-connecting agents. Offline recovers via retry.
    tryEnsure('session_runtime_wake', agentIdsNeedingConnectingWake(entries))
  }, [args.sessionId, args.teamId, engagedSignature, tryEnsure, presenceByActor])

  React.useEffect(() => {
    const sessionId = args.sessionId?.trim() || null
    const teamId = args.teamId?.trim() || null
    if (!sessionId || !teamId) return
    if (!hasRecoverableNonReadyAgent(args.engagedUiEntries, presenceByActor)) return

    const timer = window.setInterval(() => {
      tryEnsure(
        'session_runtime_retry',
        agentIdsNeedingRecoverableRuntimeWake(engagedUiEntriesRef.current, presenceByActor),
      )
    }, STALE_RUNTIME_RETRY_MS)

    return () => window.clearInterval(timer)
  }, [args.sessionId, args.teamId, engagedSignature, presenceSignature, tryEnsure, args.engagedUiEntries, presenceByActor])
}
