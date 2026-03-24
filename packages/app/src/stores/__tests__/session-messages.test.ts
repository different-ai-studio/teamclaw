import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSendMessageAsync = vi.fn().mockResolvedValue(undefined)
const mockAbortSession = vi.fn().mockResolvedValue(undefined)
const mockGetMessages = vi.fn().mockResolvedValue([])

vi.mock('@/lib/opencode/client', () => ({
  getOpenCodeClient: () => ({
    sendMessageAsync: mockSendMessageAsync,
    sendMessageWithPartsAsync: vi.fn().mockResolvedValue(undefined),
    abortSession: mockAbortSession,
    getMessages: mockGetMessages,
  }),
}))

vi.mock('@/stores/streaming', () => ({
  useStreamingStore: Object.assign(
    () => ({ streamingMessageId: null }),
    {
      getState: () => ({
        streamingMessageId: null,
        setStreaming: vi.fn(),
        clearStreaming: vi.fn(),
      }),
    },
  ),
}))

vi.mock('@/stores/session-converters', () => ({
  convertMessage: (m: unknown) => m,
}))

vi.mock('@/stores/session-cache', () => ({
  getSessionById: vi.fn(() => null),
  updateSessionCache: vi.fn(),
}))

vi.mock('@/stores/telemetry', () => ({
  trackEvent: vi.fn(),
}))

vi.mock('@/stores/session-internals', () => ({
  busySessions: new Set(),
  clearMessageTimeout: vi.fn(),
  setMessageTimeout: vi.fn(),
}))

vi.mock('@/lib/insert-message-sorted', () => ({
  insertMessageSorted: (arr: unknown[], msg: unknown) => [...arr, msg],
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createMessageActions', () => {
  it('creates an object with sendMessage, abortSession, removeFromQueue, reloadActiveSessionMessages', async () => {
    const { createMessageActions } = await import('@/stores/session-messages')
    const set = vi.fn()
    const get = vi.fn(() => ({
      activeSessionId: 'session-1',
      sessions: [],
      messageQueue: [],
      sessionStatus: null,
      selectedModel: null,
      createSession: vi.fn(),
      autoInjectKnowledge: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn(),
    }))
    const actions = createMessageActions(set as any, get as any)
    expect(typeof actions.sendMessage).toBe('function')
    expect(typeof actions.abortSession).toBe('function')
    expect(typeof actions.removeFromQueue).toBe('function')
    expect(typeof actions.reloadActiveSessionMessages).toBe('function')
  })

  it('removeFromQueue removes a message by id', async () => {
    const { createMessageActions } = await import('@/stores/session-messages')
    const set = vi.fn()
    const get = vi.fn(() => ({
      activeSessionId: 'session-1',
      sessions: [],
      messageQueue: [{ id: 'q1', content: 'hello', timestamp: new Date() }],
      sessionStatus: null,
      selectedModel: null,
      createSession: vi.fn(),
      autoInjectKnowledge: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn(),
    }))
    const actions = createMessageActions(set as any, get as any)
    actions.removeFromQueue('q1')
    expect(set).toHaveBeenCalled()
    // The set function receives a callback; call it to verify
    const callback = set.mock.calls[0][0]
    const result = callback({ messageQueue: [{ id: 'q1' }, { id: 'q2' }] })
    expect(result.messageQueue).toEqual([{ id: 'q2' }])
  })

  it('sendMessage does nothing for empty content', async () => {
    const { createMessageActions } = await import('@/stores/session-messages')
    const set = vi.fn()
    const get = vi.fn(() => ({
      activeSessionId: 'session-1',
      sessions: [],
      messageQueue: [],
      sessionStatus: null,
      selectedModel: null,
      createSession: vi.fn(),
      autoInjectKnowledge: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn(),
    }))
    const actions = createMessageActions(set as any, get as any)
    await actions.sendMessage('   ')
    expect(mockSendMessageAsync).not.toHaveBeenCalled()
  })
})
