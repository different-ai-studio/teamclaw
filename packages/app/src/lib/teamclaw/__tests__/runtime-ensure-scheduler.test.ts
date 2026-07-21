import { create } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AgentStatus,
  RuntimeInfoSchema,
  RuntimeLifecycle,
} from '@/lib/proto/amux_pb'
import {
  agentsHaveLiveRuntimeModels,
  isRuntimeEnsureWakeReason,
  recordRuntimeEnsureAttempt,
  resetRuntimeEnsureThrottle,
  runtimeEnsureKey,
  shouldSkipAlreadyReadyRuntimeEnsure,
  shouldSkipThrottledRuntimeEnsure,
} from '@/lib/teamclaw/runtime-ensure-scheduler'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'

describe('runtime-ensure-scheduler', () => {
  beforeEach(() => {
    resetRuntimeEnsureThrottle()
    useRuntimeStateStore.setState({ byRuntimeId: {} })
  })

  it('does not skip before any attempt is recorded', () => {
    expect(shouldSkipThrottledRuntimeEnsure('session-a', ['agent-1'])).toBe(false)
  })

  it('skips duplicate attempts within the throttle window', () => {
    recordRuntimeEnsureAttempt('session-a', ['agent-1'])
    expect(shouldSkipThrottledRuntimeEnsure('session-a', ['agent-1'])).toBe(true)
  })

  it('does not skip a different session or agent set', () => {
    recordRuntimeEnsureAttempt('session-a', ['agent-1'])
    expect(shouldSkipThrottledRuntimeEnsure('session-b', ['agent-1'])).toBe(false)
    expect(shouldSkipThrottledRuntimeEnsure('session-a', ['agent-2'])).toBe(false)
  })

  it('reset clears throttle state', () => {
    recordRuntimeEnsureAttempt('session-a', ['agent-1'])
    resetRuntimeEnsureThrottle()
    expect(shouldSkipThrottledRuntimeEnsure('session-a', ['agent-1'])).toBe(false)
  })

  it('runtimeEnsureKey is stable regardless of agent order', () => {
    expect(runtimeEnsureKey('s', ['b', 'a'])).toBe(runtimeEnsureKey('s', ['a', 'b']))
  })

  it('classifies wake vs create/send reasons', () => {
    expect(isRuntimeEnsureWakeReason('session_focus')).toBe(true)
    expect(isRuntimeEnsureWakeReason('mqtt_reconnect_ensure')).toBe(true)
    expect(isRuntimeEnsureWakeReason('session_auto_engage')).toBe(true)
    expect(isRuntimeEnsureWakeReason('session_create')).toBe(false)
    expect(isRuntimeEnsureWakeReason('outbox_send')).toBe(false)
    expect(isRuntimeEnsureWakeReason('offline_banner_retry')).toBe(false)
  })

  it('skips wake ensures when ACTIVE retain already has models', () => {
    useRuntimeStateStore.getState().upsert(
      'rt-1',
      'agent-1',
      create(RuntimeInfoSchema, {
        runtimeId: 'rt-1',
        state: RuntimeLifecycle.ACTIVE,
        status: AgentStatus.IDLE,
        availableModels: [{ id: 'm1', displayName: 'Model 1' }],
      }),
    )
    expect(agentsHaveLiveRuntimeModels(['agent-1'])).toBe(true)
    expect(shouldSkipAlreadyReadyRuntimeEnsure(['agent-1'], 'session_focus')).toBe(true)
    expect(shouldSkipAlreadyReadyRuntimeEnsure(['agent-1'], 'session_create')).toBe(false)
  })

  it('does not skip wake ensures when models are missing', () => {
    useRuntimeStateStore.getState().upsert(
      'rt-1',
      'agent-1',
      create(RuntimeInfoSchema, {
        runtimeId: 'rt-1',
        state: RuntimeLifecycle.ACTIVE,
        status: AgentStatus.IDLE,
        availableModels: [],
      }),
    )
    expect(shouldSkipAlreadyReadyRuntimeEnsure(['agent-1'], 'session_focus')).toBe(false)
  })
})
