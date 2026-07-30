import { describe, it, expect } from 'vitest'
import { resolveLocalDaemonRuntimeStatus } from '../use-local-daemon-http-status'

describe('resolveLocalDaemonRuntimeStatus', () => {
  it('returns offline when onboarding is not ready', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: false,
        httpStatus: 'online',
        daemonMqttConnected: true,
      }),
    ).toBe('offline')
  })

  it('returns offline when http probe fails', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'offline',
        daemonMqttConnected: true,
      }),
    ).toBe('offline')
  })

  it('returns online when the daemon is reachable and its mqtt link is up', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'online',
        daemonMqttConnected: true,
      }),
    ).toBe('online')
  })

  it('returns daemonMqttDisconnected when the daemon is up but its mqtt link is down', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'online',
        daemonMqttConnected: false,
      }),
    ).toBe('daemonMqttDisconnected')
  })

  it('stays checking while the http probe is in flight', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'checking',
        daemonMqttConnected: false,
      }),
    ).toBe('checking')
  })

  it('stays checking when http is online but the daemon mqtt probe is pending', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'online',
        daemonMqttConnected: null,
      }),
    ).toBe('checking')
  })

  it('stays checking before the first probe runs', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'idle',
        daemonMqttConnected: null,
      }),
    ).toBe('checking')
  })
})
