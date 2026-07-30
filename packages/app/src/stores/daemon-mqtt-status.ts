import * as React from 'react'
import { create } from 'zustand'
import { noteLocalDaemonSignals } from '@/lib/agent-device-reachability'
import { getDaemonMqttConnected } from '@/lib/daemon-agent-admin'
import { onDaemonProbeRequested } from '@/lib/daemon-probe-signal'
import { getKnownLocalDaemonActorId } from '@/lib/local-daemon-identity'
import { QUICK_CHAT_DAEMON_PROBE_INTERVAL_MS } from '@/lib/session-agent-probe'

type DaemonMqttStatusState = {
  /** Daemon's own MQTT link from `GET /v1/info`. `null` = unknown / daemon unreachable. */
  connected: boolean | null
  setConnected: (connected: boolean | null) => void
  refresh: () => Promise<void>
}

/**
 * Shared daemon-MQTT state, polled exactly once for the whole app.
 *
 * Both the sidebar status dot and the Daemon settings MQTT card read this. They
 * used to each run their own `getDaemonMqttConnected()` interval, so the two
 * views could disagree for up to a full poll period purely from timer skew —
 * which read to users as "the two places don't match" (#522).
 */
export const useDaemonMqttStatusStore = create<DaemonMqttStatusState>((set) => ({
  connected: null,
  setConnected: (connected) => set({ connected }),
  refresh: async () => {
    const connected = await getDaemonMqttConnected()
    set({ connected })
    // Warm the short-TTL device-reachability cache on every tick, not just when
    // the value flips — the runtime-start gate reads it synchronously and a
    // change-only write would leave it permanently expired.
    const actorId = getKnownLocalDaemonActorId()
    if (actorId) noteLocalDaemonSignals({ actorId, daemonMqttConnected: connected })
  },
}))

let subscriberCount = 0
let pollTimer: ReturnType<typeof setInterval> | null = null
let unsubscribeProbe: (() => void) | null = null

function startPolling() {
  const poll = () => void useDaemonMqttStatusStore.getState().refresh()
  poll()
  pollTimer = setInterval(poll, QUICK_CHAT_DAEMON_PROBE_INTERVAL_MS)
  // Retry / network-online should not have to wait out the poll interval.
  unsubscribeProbe = onDaemonProbeRequested(() => poll())
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  unsubscribeProbe?.()
  unsubscribeProbe = null
  useDaemonMqttStatusStore.setState({ connected: null })
}

/**
 * Ref-counted subscription to the shared poll. The interval runs while at least
 * one mounted consumer wants it and is torn down once the last one leaves.
 */
export function subscribeDaemonMqttStatus(): () => void {
  subscriberCount += 1
  if (subscriberCount === 1) startPolling()
  let released = false
  return () => {
    if (released) return
    released = true
    subscriberCount -= 1
    if (subscriberCount === 0) stopPolling()
  }
}

/**
 * Daemon's own MQTT connection state. Pass `enabled: false` while the daemon is
 * not expected to be up (onboarding incomplete) to avoid pointless polling.
 */
export function useDaemonMqttConnected(enabled = true): boolean | null {
  const connected = useDaemonMqttStatusStore((s) => s.connected)
  React.useEffect(() => {
    if (!enabled) return
    return subscribeDaemonMqttStatus()
  }, [enabled])
  return enabled ? connected : null
}

/** @internal test helper */
export function __resetDaemonMqttStatusForTests(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  unsubscribeProbe?.()
  unsubscribeProbe = null
  subscriberCount = 0
  useDaemonMqttStatusStore.setState({ connected: null })
}
