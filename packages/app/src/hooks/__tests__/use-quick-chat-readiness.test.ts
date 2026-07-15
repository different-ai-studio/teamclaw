import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  QUICK_CHAT_STUCK_RETRY_MS,
  useQuickChatReadiness,
} from '../use-quick-chat-readiness'

const mocks = vi.hoisted(() => ({
  teamId: 'team-1' as string | null,
  workspacePath: '/ws' as string | null,
  defaultAgentId: null as string | null,
  effectiveDefaultAgentId: null as string | null,
  effectiveDefaultTeamId: null as string | null,
  resolvedTarget: null as { agentId: string; displayName: string; source: 'team_default' } | null,
  resolveThrows: false,
  mqttConnected: null as boolean | null,
  mqttReconnectNonce: 0,
}))

vi.mock('@/stores/mqtt-reconnect', () => ({
  useMqttReconnectStore: (
    selector: (s: { connected: boolean | null; nonce: number }) => unknown,
  ) => selector({ connected: mocks.mqttConnected, nonce: mocks.mqttReconnectNonce }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: { workspacePath: string | null }) => unknown) =>
    selector({ workspacePath: mocks.workspacePath }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (s: { team: { id: string } | null }) => unknown) =>
    selector({ team: mocks.teamId ? { id: mocks.teamId } : null }),
}))

vi.mock('@/stores/member-preferences-store', () => ({
  useMemberPreferencesStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      defaultAgentId: mocks.defaultAgentId,
      effectiveDefaultAgentId: mocks.effectiveDefaultAgentId,
      effectiveDefaultTeamId: mocks.effectiveDefaultTeamId,
      loadEffectiveDefaultAgent: vi.fn(async () => {}),
    }),
}))

vi.mock('@/lib/resolve-quick-chat-target', () => ({
  resolveQuickChatTarget: vi.fn(async () => {
    if (mocks.resolveThrows) throw new Error('resolve failed')
    return mocks.resolvedTarget
  }),
}))

const readyTarget = {
  agentId: 'agent-1',
  displayName: 'MACPRO',
  source: 'team_default' as const,
}

describe('useQuickChatReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.teamId = 'team-1'
    mocks.workspacePath = '/ws'
    mocks.defaultAgentId = null
    mocks.effectiveDefaultAgentId = null
    mocks.effectiveDefaultTeamId = 'team-1'
    mocks.resolvedTarget = null
    mocks.resolveThrows = false
    mocks.mqttConnected = null
    mocks.mqttReconnectNonce = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns no_team when teamId is missing', () => {
    mocks.teamId = null
    const { result } = renderHook(() => useQuickChatReadiness())
    expect(result.current).toEqual({ kind: 'no_team' })
  })

  it('returns no_agent when resolver returns null', async () => {
    const { result } = renderHook(() => useQuickChatReadiness())
    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'no_agent' })
    })
  })

  it('returns ready when resolver returns a target', async () => {
    mocks.resolvedTarget = readyTarget
    const { result } = renderHook(() => useQuickChatReadiness())
    await waitFor(() => {
      expect(result.current).toEqual({
        kind: 'ready',
        target: mocks.resolvedTarget,
      })
    })
  })

  it('returns no_agent when resolver throws', async () => {
    mocks.resolveThrows = true
    const { result } = renderHook(() => useQuickChatReadiness())
    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'no_agent' })
    })
  })

  it('re-resolves after MQTT reconnects from disconnected', async () => {
    const { resolveQuickChatTarget } = await import('@/lib/resolve-quick-chat-target')
    mocks.mqttConnected = false

    const { result, rerender } = renderHook(() => useQuickChatReadiness())

    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'no_agent' })
    })
    expect(resolveQuickChatTarget).toHaveBeenCalledTimes(1)

    mocks.resolvedTarget = readyTarget
    mocks.mqttConnected = true
    await act(async () => {
      rerender()
    })

    await waitFor(() => {
      expect(result.current).toEqual({
        kind: 'ready',
        target: mocks.resolvedTarget,
      })
    })
    expect(resolveQuickChatTarget).toHaveBeenCalledTimes(2)
  })

  it('re-resolves when MQTT becomes connected from unknown', async () => {
    const { resolveQuickChatTarget } = await import('@/lib/resolve-quick-chat-target')
    mocks.mqttConnected = null

    const { result, rerender } = renderHook(() => useQuickChatReadiness())

    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'no_agent' })
    })
    expect(resolveQuickChatTarget).toHaveBeenCalledTimes(1)

    mocks.resolvedTarget = readyTarget
    mocks.mqttConnected = true
    await act(async () => {
      rerender()
    })

    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'ready', target: readyTarget })
    })
    expect(resolveQuickChatTarget).toHaveBeenCalledTimes(2)
  })

  it('re-resolves on window online after resolver returned null', async () => {
    const { resolveQuickChatTarget } = await import('@/lib/resolve-quick-chat-target')
    mocks.mqttConnected = true

    const { result } = renderHook(() => useQuickChatReadiness())

    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'no_agent' })
    })
    expect(resolveQuickChatTarget).toHaveBeenCalledTimes(1)

    mocks.resolvedTarget = readyTarget
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })

    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'ready', target: readyTarget })
    })
    expect(resolveQuickChatTarget).toHaveBeenCalledTimes(2)
  })

  it('re-resolves when the tab becomes visible again', async () => {
    const { resolveQuickChatTarget } = await import('@/lib/resolve-quick-chat-target')
    mocks.mqttConnected = true
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })

    const { result } = renderHook(() => useQuickChatReadiness())

    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'no_agent' })
    })

    mocks.resolvedTarget = readyTarget
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'ready', target: readyTarget })
    })
    expect(resolveQuickChatTarget).toHaveBeenCalledTimes(2)
  })

  it('re-resolves when MQTT reconnect nonce bumps', async () => {
    const { resolveQuickChatTarget } = await import('@/lib/resolve-quick-chat-target')
    mocks.mqttConnected = true

    const { result, rerender } = renderHook(() => useQuickChatReadiness())

    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'no_agent' })
    })

    mocks.resolvedTarget = readyTarget
    mocks.mqttReconnectNonce = 1
    await act(async () => {
      rerender()
    })

    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'ready', target: readyTarget })
    })
    expect(resolveQuickChatTarget).toHaveBeenCalledTimes(2)
  })

  it('re-resolves on periodic retry while stuck in no_agent', async () => {
    vi.useFakeTimers()
    const { resolveQuickChatTarget } = await import('@/lib/resolve-quick-chat-target')
    mocks.mqttConnected = true

    const { result } = renderHook(() => useQuickChatReadiness())

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current).toEqual({ kind: 'no_agent' })
    expect(resolveQuickChatTarget).toHaveBeenCalledTimes(1)

    mocks.resolvedTarget = readyTarget
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUICK_CHAT_STUCK_RETRY_MS)
      await Promise.resolve()
    })

    expect(result.current).toEqual({ kind: 'ready', target: readyTarget })
    expect(resolveQuickChatTarget).toHaveBeenCalledTimes(2)
  })

  it('does not re-resolve when already ready on MQTT reconnect', async () => {
    const { resolveQuickChatTarget } = await import('@/lib/resolve-quick-chat-target')
    mocks.resolvedTarget = readyTarget
    mocks.mqttConnected = false

    const { result, rerender } = renderHook(() => useQuickChatReadiness())

    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'ready', target: readyTarget })
    })
    const callsAfterReady = vi.mocked(resolveQuickChatTarget).mock.calls.length

    mocks.mqttConnected = true
    await act(async () => {
      rerender()
    })

    expect(resolveQuickChatTarget).toHaveBeenCalledTimes(callsAfterReady)
    expect(result.current).toEqual({ kind: 'ready', target: readyTarget })
  })
})
