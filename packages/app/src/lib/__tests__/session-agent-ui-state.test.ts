import { describe, it, expect } from 'vitest'
import { RuntimeLifecycle } from '@/lib/proto/amux_pb'
import {
  isDriftedLocalGhostBinding,
  resolveSessionAgentUiState,
} from '@/lib/session-agent-ui-state'

describe('isDriftedLocalGhostBinding', () => {
  it('detects ghost online retain for a superseded local actor', () => {
    expect(
      isDriftedLocalGhostBinding({
        agentId: 'old-macpro',
        localDaemonActorId: 'new-local',
        presenceOnline: true,
        agentRuntimeInfo: undefined,
        agentAvailableModelCount: 0,
        localRuntimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        localAvailableModelCount: 2,
      }),
    ).toBe(true)
  })

  it('ignores remote offline agents', () => {
    expect(
      isDriftedLocalGhostBinding({
        agentId: 'remote-agent',
        localDaemonActorId: 'local-agent',
        presenceOnline: false,
        agentRuntimeInfo: undefined,
        agentAvailableModelCount: 0,
        localRuntimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        localAvailableModelCount: 2,
      }),
    ).toBe(false)
  })
})

describe('resolveSessionAgentUiState', () => {
  it('returns stale when binding superseded', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: true,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: true,
        connectingTimedOut: false,
      }),
    ).toBe('stale')
  })

  it('returns offline when presence is false', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: false,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: false,
        connectingTimedOut: false,
      }),
    ).toBe('offline')
  })

  it('returns ready when online with models and active runtime', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: true,
        runtimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        availableModelCount: 2,
        isStaleBinding: false,
        connectingTimedOut: false,
      }),
    ).toBe('ready')
  })

  it('returns offline when presence is false despite active runtime retain', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: false,
        runtimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        availableModelCount: 2,
        isStaleBinding: false,
        connectingTimedOut: false,
      }),
    ).toBe('offline')
  })

  it('returns ready when an active stream confirms the agent is replying despite stale offline presence', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: false,
        runtimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        availableModelCount: 0,
        isStaleBinding: false,
        connectingTimedOut: false,
        activeStreamConfirmed: true,
      }),
    ).toBe('ready')
  })

  it('returns offline when reachability probe fails despite active runtime retain', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: true,
        runtimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        availableModelCount: 2,
        isStaleBinding: false,
        connectingTimedOut: false,
        reachabilityFailed: true,
      }),
    ).toBe('offline')
  })

  it('returns offline after connecting timeout', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: undefined,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: false,
        connectingTimedOut: true,
      }),
    ).toBe('offline')
  })

  it('returns offline when reachability probe fails', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: true,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: false,
        connectingTimedOut: false,
        reachabilityFailed: true,
      }),
    ).toBe('offline')
  })

  it('returns offline when online presence ghost times out without runtime', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: true,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: false,
        connectingTimedOut: true,
      }),
    ).toBe('offline')
  })
})
