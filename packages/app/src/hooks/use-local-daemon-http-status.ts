import * as React from 'react'
import { noteLocalDaemonSignals } from '@/lib/agent-device-reachability'
import { probeDaemonHttp } from '@/lib/daemon-local-client'
import { onDaemonProbeRequested } from '@/lib/daemon-probe-signal'
import { QUICK_CHAT_DAEMON_PROBE_INTERVAL_MS } from '@/lib/session-agent-probe'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import { useDaemonMqttConnected } from '@/stores/daemon-mqtt-status'

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
    // Let Retry / network-online force an immediate re-probe instead of waiting
    // out the poll interval.
    const unsubscribe = onDaemonProbeRequested(() => void runProbe())
    return () => {
      cancelled = true
      clearInterval(interval)
      unsubscribe()
    }
  }, [daemonReady, enabled])

  return enabled && daemonReady ? status : 'idle'
}

export type LocalDaemonRuntimeStatus =
  | 'checking'
  | 'online'
  | 'offline'
  | 'daemonMqttDisconnected'

/**
 * The sidebar dot reports the **daemon's** two links and nothing else:
 *
 * - `offline` (red)                  — daemon itself unreachable
 * - `daemonMqttDisconnected` (amber) — daemon reachable, its MQTT link is down
 * - `online` (green)                 — daemon reachable and its MQTT link is up
 *
 * The desktop app's *own* MQTT connection deliberately does not feed in here —
 * it is a different fact about a different connection, and mixing the two into
 * one dot is what made this indicator disagree with the Daemon settings card
 * (#522). App-side MQTT is surfaced on the user account row instead.
 *
 * Both inputs come straight from the daemon over local HTTP (probe +
 * `/v1/info.mqtt_connected`), so MQTT presence retain — which can be stale or
 * ghosted — is not consulted either.
 */
export function resolveLocalDaemonRuntimeStatus(input: {
  daemonOnboardingReady: boolean
  httpStatus: LocalDaemonHttpStatus
  /** Daemon's own MQTT link from GET /v1/info. `null` = not known yet. */
  daemonMqttConnected: boolean | null
}): LocalDaemonRuntimeStatus {
  if (!input.daemonOnboardingReady) return 'offline'
  if (input.httpStatus === 'offline') return 'offline'
  if (input.httpStatus === 'checking' || input.httpStatus === 'idle') return 'checking'
  // HTTP reachable — the daemon is up; the only remaining question is its MQTT link.
  if (input.daemonMqttConnected === false) return 'daemonMqttDisconnected'
  if (input.daemonMqttConnected === true) return 'online'
  return 'checking'
}

/** Unified local-daemon status for the sidebar card (HTTP + MQTT + presence). */
export function useLocalDaemonRuntimeStatus(
  actorId: string | null,
  enabled = true,
): LocalDaemonRuntimeStatus {
  const daemonOnboardingReady = useDaemonOnboardingStore((s) => s.status === 'ready')
  const httpStatus = useLocalDaemonHttpStatus(enabled)
  const daemonMqttConnected = useDaemonMqttConnected(enabled && daemonOnboardingReady)

  // The daemon-MQTT half of the reachability cache is warmed by the shared poll
  // itself (`daemon-mqtt-status`); this only contributes the HTTP-probe half.
  React.useEffect(() => {
    if (!actorId) return
    noteLocalDaemonSignals({
      actorId,
      localHttpOk: httpStatus === 'online' ? true : httpStatus === 'offline' ? false : null,
    })
  }, [actorId, httpStatus])

  return resolveLocalDaemonRuntimeStatus({
    daemonOnboardingReady,
    httpStatus,
    daemonMqttConnected,
  })
}
