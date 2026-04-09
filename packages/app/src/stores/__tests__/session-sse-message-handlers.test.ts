import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/opencode/sdk-client', () => ({
  getOpenCodeClient: () => ({
    getMessages: vi.fn().mockResolvedValue([]),
  }),
}))

vi.mock('@/stores/streaming', () => {
  const state = {
    streamingMessageId: null as string | null,
    streamingContent: '',
    setStreaming: vi.fn(),
    clearStreaming: vi.fn(),
  }
  return {
    useStreamingStore: Object.assign(
      (sel: (s: typeof state) => unknown) => sel(state),
      { getState: () => state },
    ),
    clearTypewriterBuffers: vi.fn(),
    appendTextBuffer: vi.fn(),
    appendReasoningBuffer: vi.fn(),
    scheduleTypewriter: vi.fn(),
    hasBufferedContent: vi.fn(() => false),
  }
})

vi.mock('@/lib/opencode/sdk-sse', () => ({
  clearAllChildSessions: vi.fn(),
}))

vi.mock('@/lib/insert-message-sorted', () => ({
  insertMessageSorted: (msgs: unknown[], msg: unknown) => [...msgs, msg],
}))

import { createMessageHandlers } from '@/stores/session-sse-message-handlers'
import { sessionLookupCache } from '@/stores/session-cache'
import { externalReloadingSessions } from '@/stores/session-internals'
import { useStreamingStore, appendTextBuffer, scheduleTypewriter } from '@/stores/streaming'

describe('session-sse-message-handlers', () => {
  let state: Record<string, unknown>
  let set: ReturnType<typeof vi.fn>
  let get: ReturnType<typeof vi.fn>
  let handlers: ReturnType<typeof createMessageHandlers>

  beforeEach(() => {
    vi.clearAllMocks()
    sessionLookupCache.clear()
    externalReloadingSessions.clear()

    state = {
      activeSessionId: 'sess-1',
      sessions: [{
        id: 'sess-1',
        title: 'Test',
        messages: [
          { id: 'temp-user-123', sessionId: 'sess-1', role: 'user', content: 'hi', parts: [], timestamp: new Date() },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      messageQueue: [],
      sendMessage: vi.fn(),
    }
    // Populate cache
    sessionLookupCache.set('sess-1', state.sessions[0] as any)

    set = vi.fn((updater) => {
      if (typeof updater === 'function') {
        const partial = updater(state)
        if (partial.sessions) {
          state.sessions = partial.sessions
          partial.sessions.forEach((s: any) => sessionLookupCache.set(s.id, s))
        }
        Object.assign(state, partial)
      } else {
        Object.assign(state, updater)
      }
    })
    get = vi.fn(() => state)
    handlers = createMessageHandlers(set, get)
  })

  it('handleMessageCreated for user role updates temp ID to real ID', () => {
    handlers.handleMessageCreated({
      sessionId: 'sess-1',
      id: 'real-user-id',
      role: 'user',
      createdAt: Date.now(),
    } as any)

    // set should have been called to update the temp user message id
    expect(set).toHaveBeenCalled()
    const session = sessionLookupCache.get('sess-1')
    expect(session?.messages[0].id).toBe('real-user-id')
  })

  it('handleMessageCreated ignores events for different sessions', () => {
    handlers.handleMessageCreated({
      sessionId: 'other-session',
      id: 'msg-1',
      role: 'assistant',
      createdAt: Date.now(),
    } as any)

    expect(set).not.toHaveBeenCalled()
  })

  it('handleMessageCreated for assistant creates new message when no pending', () => {
    // Clear the streaming store mock state
    const streamState = useStreamingStore.getState()
    streamState.streamingMessageId = null

    handlers.handleMessageCreated({
      sessionId: 'sess-1',
      id: 'assist-msg-1',
      role: 'assistant',
      createdAt: Date.now(),
    } as any)

    expect(set).toHaveBeenCalled()
    const session = sessionLookupCache.get('sess-1')
    const assistMsg = session?.messages.find((m: any) => m.id === 'assist-msg-1')
    expect(assistMsg).toBeDefined()
    expect(assistMsg?.role).toBe('assistant')
    expect(assistMsg?.isStreaming).toBe(true)
  })

  it('handleMessagePartUpdated buffers text_delta and schedules typewriter', () => {
    const streamState = useStreamingStore.getState()
    streamState.streamingMessageId = 'assist-msg-1'

    handlers.handleMessagePartUpdated({
      messageId: 'assist-msg-1',
      partId: 'part-1',
      type: 'text_delta',
      delta: 'Hello ',
    } as any)

    expect(appendTextBuffer).toHaveBeenCalledWith('Hello ')
    expect(scheduleTypewriter).toHaveBeenCalled()
  })

  it('handleMessageCompleted sets isStreaming to false and clears streaming', () => {
    // Setup: add an assistant message
    const session = sessionLookupCache.get('sess-1')!
    session.messages.push({
      id: 'assist-msg-1',
      sessionId: 'sess-1',
      role: 'assistant',
      content: 'Hello',
      parts: [],
      timestamp: new Date(),
      isStreaming: true,
    } as any)
    sessionLookupCache.set('sess-1', session)
    state.sessions = [session]

    const streamState = useStreamingStore.getState()
    streamState.streamingMessageId = 'assist-msg-1'
    streamState.streamingContent = 'Hello'

    handlers.handleMessageCompleted({
      messageId: 'assist-msg-1',
      sessionId: 'sess-1',
      finalContent: 'Hello world',
    } as any)

    expect(set).toHaveBeenCalled()
    const updated = sessionLookupCache.get('sess-1')
    const msg = updated?.messages.find((m: any) => m.id === 'assist-msg-1')
    expect(msg?.isStreaming).toBe(false)
    expect(msg?.content).toBe('Hello world')
  })

  it('handleMessageCompleted ignores stale completion events for non-streaming messages', () => {
    // Setup: Two messages, msg-2 is currently streaming
    const session = sessionLookupCache.get('sess-1')!
    session.messages = [
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'Completed',
        parts: [],
        timestamp: new Date(),
        isStreaming: false,
      },
      {
        id: 'msg-2',
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'Streaming...',
        parts: [],
        timestamp: new Date(),
        isStreaming: true,
      },
    ] as any
    sessionLookupCache.set('sess-1', session)
    state.sessions = [session]

    const streamState = useStreamingStore.getState()
    streamState.streamingMessageId = 'msg-2'
    streamState.streamingContent = 'Streaming...'

    // Simulate stale completion event for msg-1
    handlers.handleMessageCompleted({
      messageId: 'msg-1',
      sessionId: 'sess-1',
      finalContent: 'Completed',
    } as any)

    // Verify: streaming state for msg-2 NOT affected
    expect(streamState.streamingMessageId).toBe('msg-2')
    expect(streamState.streamingContent).toBe('Streaming...')
    
    // Verify: set was not called (stale event ignored)
    expect(set).not.toHaveBeenCalled()
  })

  it('handleMessageCreated restores isStreaming flag when message exists (retry recovery)', () => {
    // Setup: Message exists but isStreaming was incorrectly cleared
    const session = sessionLookupCache.get('sess-1')!
    session.messages = [
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'Partial',
        parts: [],
        timestamp: new Date(),
        isStreaming: false, // Incorrectly cleared by stale completion
      },
    ] as any
    sessionLookupCache.set('sess-1', session)
    state.sessions = [session]

    const streamState = useStreamingStore.getState()
    streamState.streamingMessageId = null

    // Simulate message.created for existing message (retry sends duplicate message.updated)
    handlers.handleMessageCreated({
      id: 'msg-1',
      sessionId: 'sess-1',
      role: 'assistant',
      createdAt: new Date().toISOString(),
    } as any)

    // Verify: isStreaming flag restored
    const updated = sessionLookupCache.get('sess-1')
    const msg = updated?.messages.find((m: any) => m.id === 'msg-1')
    expect(msg?.isStreaming).toBe(true)

    // Verify: streaming state restored
    expect(streamState.setStreaming).toHaveBeenCalledWith('msg-1', 'Partial')
  })
})
