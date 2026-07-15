import * as React from 'react'
import { getBackend } from '@/lib/backend'
import { sessionFlowError, sessionFlowLog } from '@/lib/session-flow-log'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionListStore } from '@/stores/session-list-store'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'

function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false
  }
  return true
}

function runtimeRowsToMap(
  rows: Array<{
    agent_id?: string | null
    runtime_id?: string | null
    session_id?: string | null
  }>,
  sessionId: string,
): Map<string, string> {
  const runtimeMap = new Map<string, string>()
  for (const row of rows.filter((r) => r.session_id === sessionId)) {
    if (row.agent_id && row.runtime_id && !runtimeMap.has(row.agent_id)) {
      runtimeMap.set(row.agent_id, row.runtime_id)
    }
  }
  return runtimeMap
}

function runtimeTargetRowsToMap(
  rows: Array<{
    agent_id?: string | null
    runtime_id?: string | null
  }>,
): Map<string, string> {
  const runtimeMap = new Map<string, string>()
  for (const row of rows) {
    if (row.agent_id && row.runtime_id && !runtimeMap.has(row.agent_id)) {
      runtimeMap.set(row.agent_id, row.runtime_id)
    }
  }
  return runtimeMap
}

export type EngagedAgentRuntimeMaps = {
  agentToRuntimeId: Map<string, string>
  agentToBackendType: Map<string, string>
}

/** agentId → runtime_id / backend_type for the active session (single source for ChatPanel). */
export function useEngagedAgentRuntimeMap(
  activeSessionId: string | null,
  engagedAgentIds: string[],
): EngagedAgentRuntimeMaps {
  const [agentToRuntimeId, setAgentToRuntimeId] = React.useState<Map<string, string>>(() => new Map())
  const [agentToBackendType, setAgentToBackendType] = React.useState<Map<string, string>>(() => new Map())
  const runtimeStates = useRuntimeStateStore((s) => s.byRuntimeId)
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const sessionTeamId = useSessionListStore((s) =>
    activeSessionId ? s.rows.find((row) => row.id === activeSessionId)?.team_id ?? null : null,
  )
  const teamId = sessionTeamId ?? currentTeamId
  const engagedAgentIdSignature = engagedAgentIds.join(',')

  const applyRows = React.useCallback(
    (
      rtRows: Array<{
        agent_id?: string | null
        runtime_id?: string | null
        backend_type?: string | null
        session_id?: string | null
      }>,
    ) => {
      if (!activeSessionId) return
      const sessionRows = rtRows.filter((row) => row.session_id === activeSessionId)
      const runtimeMap = new Map<string, string>()
      const backendMap = new Map<string, string>()
      for (const r of sessionRows) {
        if (r.agent_id && r.runtime_id && !runtimeMap.has(r.agent_id)) {
          runtimeMap.set(r.agent_id, r.runtime_id)
        }
        if (r.agent_id && r.backend_type && !backendMap.has(r.agent_id)) {
          backendMap.set(r.agent_id, r.backend_type)
        }
      }
      setAgentToRuntimeId((prev) => (mapsEqual(prev, runtimeMap) ? prev : runtimeMap))
      setAgentToBackendType((prev) => (mapsEqual(prev, backendMap) ? prev : backendMap))
    },
    [activeSessionId],
  )

  React.useEffect(() => {
    const ids = engagedAgentIdSignature.split(',').filter(Boolean)
    if (!activeSessionId || !teamId || ids.length === 0) {
      setAgentToRuntimeId((prev) => (prev.size === 0 ? prev : new Map()))
      setAgentToBackendType((prev) => (prev.size === 0 ? prev : new Map()))
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const [rtRows, targetRows] = await Promise.all([
          getBackend().runtime.listLatestAgentRuntimeHints(teamId, ids),
          getBackend().runtime.listRuntimeTargetsForSession(activeSessionId, ids),
        ])
        if (cancelled) return
        applyRows(rtRows)
        const targetRuntimeMap = runtimeTargetRowsToMap(targetRows)
        const runtimeMap =
          targetRuntimeMap.size > 0 ? targetRuntimeMap : runtimeRowsToMap(rtRows, activeSessionId)
        setAgentToRuntimeId((prev) => (mapsEqual(prev, runtimeMap) ? prev : runtimeMap))
        sessionFlowLog('engaged_runtime_map.loaded', {
          sessionId: activeSessionId,
          rowCount: rtRows.length,
          targetCount: targetRows.length,
        })
      } catch (error) {
        sessionFlowError('engaged_runtime_map.load_failed', error, { sessionId: activeSessionId })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeSessionId, teamId, engagedAgentIdSignature, applyRows])

  const missingSignature = React.useMemo(() => {
    if (!engagedAgentIdSignature) return ''
    return engagedAgentIdSignature
      .split(',')
      .filter((id) => id && !agentToRuntimeId.has(id))
      .sort()
      .join(',')
  }, [engagedAgentIdSignature, agentToRuntimeId])

  const retainSignature = React.useMemo(() => {
    if (!engagedAgentIdSignature) return ''
    const ids = new Set(engagedAgentIdSignature.split(',').filter(Boolean))
    return Object.entries(runtimeStates)
      .filter(([, e]) => ids.has(e.daemonActorId))
      .map(([rid]) => rid)
      .sort()
      .join(',')
  }, [runtimeStates, engagedAgentIdSignature])

  const refetchKeyRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    refetchKeyRef.current = null
  }, [activeSessionId, engagedAgentIdSignature])

  React.useEffect(() => {
    if (!activeSessionId || !teamId || !missingSignature || !retainSignature) return
    const refetchKey = `${missingSignature}|${retainSignature}`
    if (refetchKeyRef.current === refetchKey) return
    refetchKeyRef.current = refetchKey
    let cancelled = false
    void (async () => {
      try {
        const targetRows = await getBackend().runtime.listRuntimeTargetsForSession(
          activeSessionId,
          missingSignature.split(',').filter(Boolean),
        )
        if (cancelled) return
        setAgentToRuntimeId((prev) => {
          const next = new Map(prev)
          let changed = false
          for (const [agentId, runtimeId] of runtimeTargetRowsToMap(targetRows)) {
            if (!next.has(agentId)) {
              next.set(agentId, runtimeId)
              changed = true
            }
          }
          return changed ? next : prev
        })
      } catch {
        /* best-effort */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeSessionId, teamId, missingSignature, retainSignature, engagedAgentIdSignature])

  const missingBackendSignature = React.useMemo(() => {
    if (!engagedAgentIdSignature) return ''
    return engagedAgentIdSignature
      .split(',')
      .filter((id) => id && !agentToBackendType.has(id))
      .sort()
      .join(',')
  }, [engagedAgentIdSignature, agentToBackendType])

  React.useEffect(() => {
    if (!teamId || !missingBackendSignature) return
    const ids = missingBackendSignature.split(',').filter(Boolean)
    let cancelled = false
    void (async () => {
      try {
        const rows = await getBackend().runtime.listLatestAgentRuntimeHints(teamId, ids)
        if (cancelled) return
        const latestByAgent = new Map<string, string>()
        for (const r of rows) {
          if (r.agent_id && r.backend_type && !latestByAgent.has(r.agent_id)) {
            latestByAgent.set(r.agent_id, r.backend_type)
          }
        }
        if (latestByAgent.size === 0) return
        setAgentToBackendType((prev) => {
          const next = new Map(prev)
          let changed = false
          latestByAgent.forEach((bt, id) => {
            if (!next.has(id)) {
              next.set(id, bt)
              changed = true
            }
          })
          return changed ? next : prev
        })
      } catch {
        /* best-effort */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [teamId, missingBackendSignature])

  return { agentToRuntimeId, agentToBackendType }
}
