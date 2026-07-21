import * as React from 'react'
import { mergeAgentDevicePresence, noteLocalDaemonSignals } from '@/lib/agent-device-reachability'
import { probeDaemonHttp } from '@/lib/daemon-local-client'
import { getDaemonMqttConnected } from '@/lib/daemon-agent-admin'
import { QUICK_CHAT_DAEMON_PROBE_INTERVAL_MS } from '@/lib/session-agent-probe'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { useMqttConnected } from '@/hooks/useMqttConnected'

export type LocalDaemonHttpStatus = 'idle' | 'checking' | 'online' | 'offline'

export function useLocalDaemonHttpStatus(enabled = true): LocalDaemonHttpStatus {
  const daemonReady = useDaemonOnboardingStore((s) => s.status === 'ready')
  const [status, setStatus] = React.useState<LocalDaemonHttpStatus>('idle')

  React.useEffect(() => {
    if (!enabled || !daemonReady) {
      setStatus('idle')
      return
    }

    let cancelled = false
    const runProbe = async () => {
      const probe = await probeDaemonHttp()
      if (cancelled) return
      setStatus(probe.ok ? 'online' : 'offline')
    }

    setStatus('checking')
    void runProbe()
    const interval = setInterval(() => void runProbe(), QUICK_CHAT_DAEMON_PROBE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [daemonReady, enabled])

  return enabled && daemonReady ? status : 'idle'
}

export type LocalDaemonRuntimeStatus =
  | 'checking'
  | 'online'
  | 'offline'
  | 'mqttDisconnected'

export function resolveLocalDaemonRuntimeStatus(input: {
  daemonOnboardingReady: boolean
  httpStatus: LocalDaemonHttpStatus
  presenceOnline: boolean | undefined
  mqttConnected: boolean | null
  /** Daemon's own MQTT link from GET /v1/info — authoritative over stale LWT retain. */
  daemonMqttConnected?: boolean | null
}): LocalDaemonRuntimeStatus {
  if (!input.daemonOnboardingReady) return 'offline'
  if (input.httpStatus === 'offline') return 'offline'
  if (input.httpStatus === 'checking' || input.httpStatus === 'idle') return 'checking'
  if (input.httpStatus === 'online' && input.mqttConnected === null) return 'checking'
  // HTTP reachable: surface Desktop MQTT disconnect before stale presence can
  // read as "online".
  if (input.mqttConnected === false) return 'mqttDisconnected'

  // Shared device-reachability merge (same rule as runtime-start gate).
  const devicePresence = mergeAgentDevicePresence({
    mqttOnline: input.presenceOnline,
    isLocalDaemon: true,
    daemonMqttConnected: input.daemonMqttConnected ?? null,
    localHttpOk: input.httpStatus === 'online' ? true : null,
  })
  if (devicePresence === 'online') return 'online'
  if (devicePresence === 'offline') return 'offline'
  return 'checking'
}

/** Unified local-daemon status for the sidebar card (HTTP + MQTT + presence). */
export function useLocalDaemonRuntimeStatus(
  actorId: string | null,
  enabled = true,
): LocalDaemonRuntimeStatus {
  const daemonOnboardingReady = useDaemonOnboardingStore((s) => s.status === 'ready')
  const httpStatus = useLocalDaemonHttpStatus(enabled)
  const mqttConnected = useMqttConnected()
  const presenceOnline = useActorPresenceStore((s) =>
    actorId ? s.byActorId[actorId]?.online : undefined,
  )
  const [daemonMqttConnected, setDaemonMqttConnected] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    if (!enabled || !daemonOnboardingReady || !actorId) {
      setDaemonMqttConnected(null)
      return
    }

    let cancelled = false
    const poll = async () => {
      const connected = await getDaemonMqttConnected()
      if (cancelled) return
      setDaemonMqttConnected(connected)
      noteLocalDaemonSignals({
        actorId,
        daemonMqttConnected: connected,
        localHttpOk: httpStatus === 'online' ? true : httpStatus === 'offline' ? false : null,
      })
    }

    void poll()
    const interval = setInterval(() => void poll(), QUICK_CHAT_DAEMON_PROBE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [actorId, daemonOnboardingReady, enabled, httpStatus])

  return resolveLocalDaemonRuntimeStatus({
    daemonOnboardingReady,
    httpStatus,
    presenceOnline,
    mqttConnected,
    daemonMqttConnected,
  })
}
