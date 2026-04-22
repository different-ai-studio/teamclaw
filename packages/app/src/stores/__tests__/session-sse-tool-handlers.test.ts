import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/opencode/sdk-client', () => ({
  getOpenCodeClient: () => ({
    getSessionDiff: vi.fn().mockResolvedValue([]),
  }),
}))

vi.mock('@/stores/streaming', () => {
  const state = {
    streamingMessageId: 'msg-assist-1' as string | null,
    streamingContent: '',
    setStreaming: vi.fn(),
    clearStreaming: vi.fn(),
  }
  return {
    useStreamingStore: Object.assign(
      (sel: (s: typeof state) => unknown) => sel(state),
      { getState: () => state },
    ),
  }
})

vi.mock('@/lib/opencode/sdk-sse', () => ({
  clearAllChildSessions: vi.fn(),
}))

import { createToolHandlers } from '@/stores/session-sse-tool-handlers'
import { sessionLookupCache } from '@/stores/session-cache'
import { sessionDataCache } from '@/stores/session-data-cache'
import { externalReloadingSessions } from '@/stores/session-internals'

describe('session-sse-tool-handlers', () => {
  let state: Record<string, unknown>
  let set: ReturnType<typeof vi.fn>
  let get: ReturnType<typeof vi.fn>
  let handlers: ReturnType<typeof createToolHandlers>

  beforeEach(() => {
    vi.clearAllMocks()
    sessionLookupCache.clear()
    sessionDataCache.clear()
    externalReloadingSessions.clear()

    const session = {
      id: 'sess-1',
      title: 'Test',
      messages: [{
        id: 'msg-assist-1',
        sessionId: 'sess-1',
        role: 'assistant',
        content: '',
        parts: [],
        toolCalls: [],
        timestamp: new Date(),
        isStreaming: true,
      }],
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    sessionLookupCache.set('sess-1', session as any)

    state = {
      activeSessionId: 'sess-1',
      sessions: [session],
      todos: [],
      sessionDiff: [],
      pendingQuestions: [],
    }

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
    handlers = createToolHandlers(set, get)
  })

  it('handleToolExecuting adds a new tool call to the message', () => {
    handlers.handleToolExecuting({
      toolCallId: 'tc-1',
      toolName: 'readFile',
      status: 'running',
      arguments: { path: '/foo.ts' },
      sessionId: 'sess-1',
      messageId: 'msg-assist-1',
    } as any)

    expect(set).toHaveBeenCalled()
    const session = sessionLookupCache.get('sess-1')
    const msg = session?.messages[0]
    expect(msg?.toolCalls).toHaveLength(1)
    expect(msg?.toolCalls![0].name).toBe('readFile')
    expect(msg?.toolCalls![0].status).toBe('calling')
  })

  it('handleToolExecuting updates existing tool call status', () => {
    // First add a tool call
    handlers.handleToolExecuting({
      toolCallId: 'tc-1',
      toolName: 'readFile',
      status: 'running',
      arguments: { path: '/foo.ts' },
      sessionId: 'sess-1',
      messageId: 'msg-assist-1',
    } as any)

    // Then complete it
    handlers.handleToolExecuting({
      toolCallId: 'tc-1',
      toolName: 'readFile',
      status: 'completed',
      result: 'file contents',
      sessionId: 'sess-1',
      messageId: 'msg-assist-1',
    } as any)

    const session = sessionLookupCache.get('sess-1')
    const tc = session?.messages[0]?.toolCalls?.find((t: any) => t.id === 'tc-1')
    expect(tc?.status).toBe('completed')
    expect(tc?.result).toBe('file contents')
  })

  it('handleToolExecuting ignores events for different sessions', () => {
    handlers.handleToolExecuting({
      toolCallId: 'tc-1',
      toolName: 'readFile',
      status: 'running',
      arguments: {},
      sessionId: 'other-session',
      messageId: 'msg-other',
    } as any)

    // Only the early-return check call (no state mutation)
    const stateMutations = set.mock.calls.filter(
      (c) => typeof c[0] === 'function'
    )
    // The function-based set should not have changed sessions
    expect(stateMutations).toHaveLength(0)
  })

  it('treats prompt-like command output as a normal running command', () => {
    handlers.handleToolExecuting({
      toolCallId: 'tc-bash-1',
      toolName: 'bash',
      status: 'running',
      arguments: { command: 'rm -rf build' },
      result: 'This will remove files. Continue? [y/N]',
      sessionId: 'sess-1',
      messageId: 'msg-assist-1',
    } as any)

    expect((state as any).pendingQuestions).toEqual([])

    const session = sessionLookupCache.get('sess-1')
    const toolCall = session?.messages[0]?.toolCalls?.find((t: any) => t.id === 'tc-bash-1')
    expect(toolCall?.status).toBe('calling')
    expect(toolCall?.questions).toBeUndefined()
  })

  it('handleTodoUpdated sets todos in state and caches them', () => {
    const todos = [
      { id: 't1', content: 'Fix bug', status: 'pending', priority: 'high' },
    ]

    handlers.handleTodoUpdated({
      sessionId: 'sess-1',
      todos,
    } as any)

    expect(set).toHaveBeenCalledWith({ todos })
    const cached = sessionDataCache.get('sess-1')
    expect(cached?.todos).toEqual(todos)
  })

  it('handleSessionDiff sets diffs in state and caches them', () => {
    const diff = [
      { file: 'src/main.ts', before: '', after: 'new', additions: 1, deletions: 0 },
    ]

    handlers.handleSessionDiff({
      sessionId: 'sess-1',
      diff,
    } as any)

    expect(set).toHaveBeenCalledWith({ sessionDiff: diff })
    const cached = sessionDataCache.get('sess-1')
    expect(cached?.diff).toEqual(diff)
  })

  it('handleTodoUpdated ignores events for non-active sessions', () => {
    handlers.handleTodoUpdated({
      sessionId: 'other-session',
      todos: [{ id: 't1', content: 'X', status: 'pending', priority: 'low' }],
    } as any)

    expect(set).not.toHaveBeenCalled()
  })
})
