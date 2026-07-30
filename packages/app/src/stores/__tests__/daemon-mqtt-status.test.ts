import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getDaemonMqttConnected = vi.hoisted(() => vi.fn<() => Promise<boolean | null>>())
const probeListeners = vi.hoisted(() => new Set<() => void>())

const noteLocalDaemonSignals = vi.hoisted(() => vi.fn())

vi.mock('@/lib/daemon-agent-admin', () => ({ getDaemonMqttConnected }))
vi.mock('@/lib/agent-device-reachability', () => ({ noteLocalDaemonSignals }))
vi.mock('@/lib/local-daemon-identity', () => ({
  getKnownLocalDaemonActorId: () => 'actor-1',
}))
vi.mock('@/lib/daemon-probe-signal', () => ({
  onDaemonProbeRequested: (fn: () => void) => {
    probeListeners.add(fn)
    return () => probeListeners.delete(fn)
  },
}))

import {
  subscribeDaemonMqttStatus,
  useDaemonMqttStatusStore,
  __resetDaemonMqttStatusForTests,
} from '@/stores/daemon-mqtt-status'

describe('daemon-mqtt-status store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    probeListeners.clear()
    getDaemonMqttConnected.mockReset()
    getDaemonMqttConnected.mockResolvedValue(true)
    noteLocalDaemonSignals.mockClear()
    __resetDaemonMqttStatusForTests()
  })

  afterEach(() => {
    __resetDaemonMqttStatusForTests()
    vi.useRealTimers()
  })

  it('polls immediately on first subscribe and publishes the result', async () => {
    const release = subscribeDaemonMqttStatus()
    expect(getDaemonMqttConnected).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(useDaemonMqttStatusStore.getState().connected).toBe(true)
    release()
  })

  it('runs a single shared poll no matter how many consumers subscribe', async () => {
    const a = subscribeDaemonMqttStatus()
    const b = subscribeDaemonMqttStatus()
    // This is the #522 fix: two views must not each drive their own interval,
    // or they drift apart by up to a full poll period.
    expect(getDaemonMqttConnected).toHaveBeenCalledTimes(1)
    a()
    b()
  })

  it('keeps polling while one consumer remains and stops after the last leaves', async () => {
    const a = subscribeDaemonMqttStatus()
    const b = subscribeDaemonMqttStatus()
    getDaemonMqttConnected.mockClear()

    a()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getDaemonMqttConnected.mock.calls.length).toBeGreaterThan(0)

    b()
    getDaemonMqttConnected.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getDaemonMqttConnected).not.toHaveBeenCalled()
  })

  it('resets to unknown once the last consumer unsubscribes', async () => {
    const release = subscribeDaemonMqttStatus()
    await vi.advanceTimersByTimeAsync(0)
    expect(useDaemonMqttStatusStore.getState().connected).toBe(true)
    release()
    expect(useDaemonMqttStatusStore.getState().connected).toBeNull()
  })

  it('is idempotent when a release function is called twice', async () => {
    const a = subscribeDaemonMqttStatus()
    const b = subscribeDaemonMqttStatus()
    a()
    a()
    getDaemonMqttConnected.mockClear()
    // `b` is still subscribed, so the double release must not have torn down.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getDaemonMqttConnected.mock.calls.length).toBeGreaterThan(0)
    b()
  })

  it('warms the reachability cache on every tick, not only when the value flips', async () => {
    const release = subscribeDaemonMqttStatus()
    await vi.advanceTimersByTimeAsync(0)
    expect(noteLocalDaemonSignals).toHaveBeenCalledTimes(1)

    // Same value on the next tick: the cache has a short TTL, so it must still
    // be re-stamped or the sync runtime-start gate reads an expired entry.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(noteLocalDaemonSignals).toHaveBeenCalledTimes(2)
    expect(noteLocalDaemonSignals).toHaveBeenLastCalledWith({
      actorId: 'actor-1',
      daemonMqttConnected: true,
    })
    release()
  })

  it('re-probes on a daemon probe request without waiting out the interval', async () => {
    const release = subscribeDaemonMqttStatus()
    await vi.advanceTimersByTimeAsync(0)
    getDaemonMqttConnected.mockClear()
    getDaemonMqttConnected.mockResolvedValue(false)

    probeListeners.forEach((fn) => fn())
    await vi.advanceTimersByTimeAsync(0)

    expect(getDaemonMqttConnected).toHaveBeenCalledTimes(1)
    expect(useDaemonMqttStatusStore.getState().connected).toBe(false)
    release()
  })
})
