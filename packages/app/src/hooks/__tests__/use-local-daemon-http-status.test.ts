import { describe, it, expect } from 'vitest'
import { resolveLocalDaemonRuntimeStatus } from '../use-local-daemon-http-status'

describe('resolveLocalDaemonRuntimeStatus', () => {
  it('returns offline when http probe fails', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'offline',
        presenceOnline: true,
        mqttConnected: true,
      }),
    ).toBe('offline')
  })

  it('returns online when http, mqtt, and presence are healthy', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'online',
        presenceOnline: true,
        mqttConnected: true,
      }),
    ).toBe('online')
  })

  it('returns mqttDisconnected when http is up but desktop mqtt is down', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'online',
        presenceOnline: true,
        mqttConnected: false,
      }),
    ).toBe('mqttDisconnected')
  })

  it('prefers mqttDisconnected over stale presence online', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'online',
        presenceOnline: true,
        mqttConnected: false,
      }),
    ).toBe('mqttDisconnected')
  })

  it('returns offline when presence is explicitly offline and mqtt is up', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'online',
        presenceOnline: false,
        mqttConnected: true,
      }),
    ).toBe('offline')
  })

  it('returns online when daemon mqtt is connected despite stale offline presence', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'online',
        presenceOnline: false,
        mqttConnected: true,
        daemonMqttConnected: true,
      }),
    ).toBe('online')
  })

  it('returns offline when daemon mqtt is down even if desktop mqtt is up', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'online',
        presenceOnline: true,
        mqttConnected: true,
        daemonMqttConnected: false,
      }),
    ).toBe('offline')
  })

  it('ignores unknown mqtt state while http is still checking', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'checking',
        presenceOnline: undefined,
        mqttConnected: false,
      }),
    ).toBe('checking')
  })

  it('stays checking when http is online but mqtt probe is pending', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'online',
        presenceOnline: true,
        mqttConnected: null,
      }),
    ).toBe('checking')
  })
})
