import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  agentIdsNeedingRuntimeWake,
  hasConnectingEngagedAgent,
  hasRecoverableNonReadyAgent,
  useEnsureEngagedRuntimesOnSessionFocus,
} from '../use-ensure-engaged-runtimes-on-session-focus'
import type { EngagedAgentUiEntry } from '../use-engaged-agent-ui-states'
import { resetRuntimeEnsureThrottle } from '@/lib/teamclaw/runtime-ensure-scheduler'

const ensureMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/teamclaw/ensure-agent-runtime', () => ({
  ensureAgentRuntimesForSession: ensureMock,
}))

function entry(id: string, uiState: EngagedAgentUiEntry['uiState']): EngagedAgentUiEntry {
  return { agent: { id, displayName: id }, uiState }
}

describe('agentIdsNeedingRuntimeWake', () => {
  it('includes connecting and offline agents only', () => {
    expect(
      agentIdsNeedingRuntimeWake([
        entry('a1', 'ready'),
        entry('a2', 'connecting'),
        entry('a3', 'offline'),
        entry('a4', 'stale'),
      ]),
    ).toEqual(['a2', 'a3'])
  })

  it('hasConnectingEngagedAgent is true only for connecting pills', () => {
    expect(
      hasConnectingEngagedAgent([
        entry('a1', 'ready'),
        entry('a2', 'offline'),
      ]),
    ).toBe(false)
    expect(
      hasConnectingEngagedAgent([entry('a1', 'connecting')]),
    ).toBe(true)
  })

  it('hasRecoverableNonReadyAgent excludes LWT-offline agents', () => {
    expect(
      hasRecoverableNonReadyAgent(
        [entry('a1', 'offline')],
        { a1: { online: false } },
      ),
    ).toBe(false)
    expect(
      hasRecoverableNonReadyAgent(
        [entry('a1', 'offline')],
        { a1: { online: true } },
      ),
    ).toBe(true)
    expect(
      hasRecoverableNonReadyAgent(
        [entry('a1', 'offline')],
        {},
      ),
    ).toBe(true)
  })
})

describe('useEnsureEngagedRuntimesOnSessionFocus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRuntimeEnsureThrottle()
  })

  it('ensures non-ready agents when session focus changes', () => {
    const { rerender } = renderHook(
      (props: {
        sessionId: string | null
        teamId: string | null
        engagedUiEntries: EngagedAgentUiEntry[]
      }) => useEnsureEngagedRuntimesOnSessionFocus(props),
      {
        initialProps: {
          sessionId: 'session-a',
          teamId: 'team-1',
          engagedUiEntries: [entry('agent-1', 'connecting')],
        },
      },
    )

    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-a',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_focus',
    })

    ensureMock.mockClear()
    resetRuntimeEnsureThrottle()

    rerender({
      sessionId: 'session-b',
      teamId: 'team-1',
      engagedUiEntries: [entry('agent-1', 'offline')],
    })

    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-b',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_focus',
    })
  })

  it('ensures when an agent becomes connecting on the same session', () => {
    const { rerender } = renderHook(
      (props: {
        sessionId: string | null
        teamId: string | null
        engagedUiEntries: EngagedAgentUiEntry[]
      }) => useEnsureEngagedRuntimesOnSessionFocus(props),
      {
        initialProps: {
          sessionId: 'session-a',
          teamId: 'team-1',
          engagedUiEntries: [entry('agent-1', 'ready')],
        },
      },
    )

    expect(ensureMock).not.toHaveBeenCalled()

    rerender({
      sessionId: 'session-a',
      teamId: 'team-1',
      engagedUiEntries: [entry('agent-1', 'connecting')],
    })

    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-a',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_runtime_wake',
    })
  })

  it('does not ensure when focus unchanged and all agents ready', () => {
    const { rerender } = renderHook(
      (props: {
        sessionId: string | null
        teamId: string | null
        engagedUiEntries: EngagedAgentUiEntry[]
      }) => useEnsureEngagedRuntimesOnSessionFocus(props),
      {
        initialProps: {
          sessionId: 'session-a',
          teamId: 'team-1',
          engagedUiEntries: [entry('agent-1', 'ready')],
        },
      },
    )

    expect(ensureMock).not.toHaveBeenCalled()

    rerender({
      sessionId: 'session-a',
      teamId: 'team-1',
      engagedUiEntries: [entry('agent-1', 'ready')],
    })

    expect(ensureMock).not.toHaveBeenCalled()
  })

  it('retries on an interval while agents stay connecting', () => {
    vi.useFakeTimers()

    renderHook(() =>
      useEnsureEngagedRuntimesOnSessionFocus({
        sessionId: 'session-a',
        teamId: 'team-1',
        engagedUiEntries: [entry('agent-1', 'connecting')],
      }),
    )

    expect(ensureMock).toHaveBeenCalledTimes(1)
    ensureMock.mockClear()
    vi.advanceTimersByTime(3_100)

    vi.advanceTimersByTime(15_000)
    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-a',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_runtime_retry',
    })

    vi.useRealTimers()
  })

  it('retries recoverable offline agents on an interval', () => {
    vi.useFakeTimers()

    renderHook(() =>
      useEnsureEngagedRuntimesOnSessionFocus({
        sessionId: 'session-a',
        teamId: 'team-1',
        engagedUiEntries: [entry('agent-1', 'offline')],
      }),
    )

    expect(ensureMock).toHaveBeenCalledTimes(1)
    ensureMock.mockClear()
    vi.advanceTimersByTime(3_100)
    vi.advanceTimersByTime(15_000)
    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-a',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_runtime_retry',
    })

    vi.useRealTimers()
  })

  it('does not retry on an interval when agent is LWT-offline', async () => {
    vi.useFakeTimers()

    const { useActorPresenceStore } = await import('@/stores/actor-presence-store')
    useActorPresenceStore.setState({
      byActorId: { 'agent-1': { online: false, displayName: 'a', lastUpdated: 0 } },
    })

    renderHook(() =>
      useEnsureEngagedRuntimesOnSessionFocus({
        sessionId: 'session-a',
        teamId: 'team-1',
        engagedUiEntries: [entry('agent-1', 'offline')],
      }),
    )

    expect(ensureMock).not.toHaveBeenCalled()
    ensureMock.mockClear()
    vi.advanceTimersByTime(15_000)
    expect(ensureMock).not.toHaveBeenCalled()

    useActorPresenceStore.setState({ byActorId: {} })
    vi.useRealTimers()
  })
})
