import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies that streaming store imports
vi.mock('@/stores/session', () => ({
  useSessionStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ activeSessionId: null }),
    {
      getState: () => ({ activeSessionId: null }),
      setState: vi.fn(),
    },
  ),
  sessionLookupCache: new Map(),
  getSessionById: vi.fn(() => null),
}))

vi.mock('@/lib/opencode/sse', () => ({
  clearAllChildSessions: vi.fn(),
}))

import { useStreamingStore } from '../streaming'

describe('streaming store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset streaming store to initial state
    useStreamingStore.setState({
      streamingMessageId: null,
      streamingContent: '',
      streamingUpdateTrigger: 0,
      childSessionStreaming: {},
    })
  })

  it('setStreaming sets streamingMessageId', () => {
    useStreamingStore.getState().setStreaming('msg-1', 'hello')
    expect(useStreamingStore.getState().streamingMessageId).toBe('msg-1')
  })

  it('clearStreaming resets streamingMessageId to null and streamingContent to empty string', () => {
    useStreamingStore.getState().setStreaming('msg-1', 'some content')
    useStreamingStore.getState().clearStreaming()

    const state = useStreamingStore.getState()
    expect(state.streamingMessageId).toBeNull()
    expect(state.streamingContent).toBe('')
  })
})
