import * as React from 'react'
import { ensureAgentRuntimesForSession } from '@/lib/teamclaw/ensure-agent-runtime'
import {
  agentIdsNeedingRecoverableRuntimeWake,
} from '@/hooks/use-ensure-engaged-runtimes-on-session-focus'
import type { EngagedAgentUiEntry } from '@/hooks/use-engaged-agent-ui-states'
import {
  resetRuntimeEnsureThrottle,
  shouldSkipAlreadyReadyRuntimeEnsure,
  shouldSkipThrottledRuntimeEnsure,
} from '@/lib/teamclaw/runtime-ensure-scheduler'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { useMqttReconnectStore } from '@/stores/mqtt-reconnect'

/** Re-ensure engaged agent runtimes once after Desktop MQTT reconnects. */
export function useReensureRuntimesOnMqttReconnect(args: {
  sessionId: string | null
  teamId: string | null
  engagedUiEntries: ReadonlyArray<EngagedAgentUiEntry>
}): void {
  const mqttConnected = useMqttReconnectStore((s) => s.connected)
  const presenceByActor = useActorPresenceStore((s) => s.byActorId)
  const prevConnectedRef = React.useRef<boolean | null>(null)
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

  React.useEffect(() => {
    const prev = prevConnectedRef.current
    prevConnectedRef.current = mqttConnected

    if (prev !== false || mqttConnected !== true) return

    const sessionId = args.sessionId?.trim() || null
    const teamId = args.teamId?.trim() || null
    if (!sessionId || !teamId) return

    const agentActorIds = agentIdsNeedingRecoverableRuntimeWake(
      engagedUiEntriesRef.current,
      presenceByActor,
    )
    if (agentActorIds.length === 0) return
    if (shouldSkipAlreadyReadyRuntimeEnsure(agentActorIds, 'mqtt_reconnect_ensure')) return

    resetRuntimeEnsureThrottle()
    if (shouldSkipThrottledRuntimeEnsure(sessionId, agentActorIds)) return

    void ensureAgentRuntimesForSession({
      sessionId,
      teamId,
      agentActorIds,
      reason: 'mqtt_reconnect_ensure',
    })
  }, [mqttConnected, args.sessionId, args.teamId, engagedSignature, presenceByActor])
}
