import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { RuntimeLifecycle } from '@/lib/proto/amux_pb'
import {
  hasAnyNonReadyEngaged,
  useEngagedAgentUiStates,
} from '../use-engaged-agent-ui-states'

const mocks = vi.hoisted(() => ({
  byRuntimeId: {} as Record<string, { info: unknown }>,
  presenceByActor: {} as Record<string, { online: boolean } | undefined>,
  probeResult: 'reachable' as 'reachable' | 'unreachable',
  localDaemonActorId: 'local-agent' as string | null,
}))

vi.mock('@/stores/runtime-state-store', () => ({
  useRuntimeStateStore: (selector: (s: { byRuntimeId: typeof mocks.byRuntimeId }) => unknown) =>
    selector({ byRuntimeId: mocks.byRuntimeId }),
}))

vi.mock('@/stores/actor-presence-store', () => ({
  useActorPresenceStore: (selector: (s: { byActorId: typeof mocks.presenceByActor }) => unknown) =>
    selector({ byActorId: mocks.presenceByActor }),
}))

vi.mock('@/lib/agent-reachability-probe', () => ({
  probeAgentReachability: vi.fn(async () => mocks.probeResult),
}))

vi.mock('@/lib/daemon-agent-admin', () => ({
  getLocalDaemonActorId: vi.fn(async () => mocks.localDaemonActorId),
}))

vi.mock('@/lib/local-daemon-identity', () => ({
  getKnownLocalDaemonActorId: () => mocks.localDaemonActorId,
  isSupersededLocalAgent: () => false,
  wasEverLocalDaemonIdentity: () => false,
  noteLocalDaemonActorId: vi.fn(),
}))

describe('hasAnyNonReadyEngaged', () => {
  it('returns true when any engaged agent is not ready', () => {
    expect(
      hasAnyNonReadyEngaged([
        { agent: { id: 'a', displayName: 'A' }, uiState: 'ready' },
        { agent: { id: 'b', displayName: 'B' }, uiState: 'offline' },
      ]),
    ).toBe(true)
  })

  it('returns false when all engaged agents are ready', () => {
    expect(
      hasAnyNonReadyEngaged([
        { agent: { id: 'a', displayName: 'A' }, uiState: 'ready' },
      ]),
    ).toBe(false)
  })
})

describe('useEngagedAgentUiStates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.byRuntimeId = {}
    mocks.presenceByActor = {}
    mocks.probeResult = 'reachable'
    mocks.localDaemonActorId = 'local-agent'
  })

  it('marks agent offline when presence is false despite active runtime retain', () => {
    mocks.localDaemonActorId = 'other-local-agent'
    mocks.presenceByActor['remote-agent'] = { online: false }
    mocks.byRuntimeId['remote-agent'] = {
      daemonActorId: 'local-agent',
      lastUpdated: Date.now(),
      info: {
        state: RuntimeLifecycle.ACTIVE,
        runtimeId: 'rt-1',
        availableModels: [{ id: 'm1', displayName: 'Model' }],
      },
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'remote-agent', displayName: 'MACPRO' }],
        new Map([['remote-agent', 'rt-1']]),
      ),
    )

    expect(result.current[0]?.uiState).toBe('offline')
  })

  it('keeps a replying remote agent ready while live stream is active despite stale offline presence', () => {
    mocks.localDaemonActorId = 'other-local-agent'
    mocks.presenceByActor['remote-agent'] = { online: false }
    mocks.byRuntimeId['remote-agent'] = {
      daemonActorId: 'remote-agent',
      lastUpdated: Date.now(),
      info: {
        state: RuntimeLifecycle.ACTIVE,
        runtimeId: 'rt-1',
        availableModels: [{ id: 'm1', displayName: 'Model' }],
      },
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'remote-agent', displayName: 'b002-agent' }],
        new Map([['remote-agent', 'rt-1']]),
        new Set(['remote-agent']),
      ),
    )

    expect(result.current[0]?.uiState).toBe('ready')
  })

  it('keeps local active runtime ready after HTTP probe succeeds despite stale offline presence', async () => {
    mocks.presenceByActor['local-agent'] = { online: false }
    mocks.probeResult = 'reachable'
    mocks.byRuntimeId['local-agent'] = {
      daemonActorId: 'local-agent',
      lastUpdated: Date.now(),
      info: {
        state: RuntimeLifecycle.ACTIVE,
        runtimeId: 'rt-1',
        availableModels: [{ id: 'm1', displayName: 'Model' }],
      },
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'local-agent', displayName: 'MACPRO' }],
        new Map([['local-agent', 'rt-1']]),
      ),
    )

    await waitFor(() => {
      expect(result.current[0]?.uiState).toBe('ready')
    }, { timeout: 3000 })
  })

  it('marks local ready agent offline when HTTP probe fails', async () => {
    mocks.presenceByActor['local-agent'] = { online: true }
    mocks.probeResult = 'unreachable'
    mocks.byRuntimeId['local-agent'] = {
      daemonActorId: 'local-agent',
      lastUpdated: Date.now(),
      info: {
        state: RuntimeLifecycle.ACTIVE,
        runtimeId: 'rt-1',
        availableModels: [{ id: 'm1', displayName: 'Model' }],
      },
    }

    const { result } = renderHook(() =>
      useEngagedAgentUiStates(
        [{ id: 'local-agent', displayName: 'MACPRO' }],
        new Map([['local-agent', 'rt-1']]),
      ),
    )

    await waitFor(() => {
      expect(result.current[0]?.uiState).toBe('offline')
    }, { timeout: 3000 })
  })
})
