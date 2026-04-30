import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setFocus: vi.fn(), unminimize: vi.fn() }),
}))

vi.mock('@/lib/notification-service', () => ({
  notificationService: { send: vi.fn() },
}))

vi.mock('@/lib/opencode/sdk-types', () => ({}))

vi.mock('@/lib/opencode/sdk-client', () => ({
  getOpenCodeClient: () => ({
    getSession: vi.fn(() => Promise.resolve(null)),
  }),
}))

vi.mock('@/lib/opencode/sdk-sse', () => ({
  registerChildSession: vi.fn(),
  isChildSession: vi.fn(() => false),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: Object.assign(
    (sel: (s: any) => any) => sel({ workspacePath: '/test' }),
    { getState: () => ({ workspacePath: '/test' }) },
  ),
}))

vi.mock('./session-types', () => ({}))

vi.mock('@/stores/session-cache', () => ({
  sessionLookupCache: new Map(),
  getSessionById: vi.fn(() => null),
  updateSessionCache: vi.fn(),
}))

vi.mock('@/stores/session-internals', () => ({
  selfCreatedSessionIds: new Set(),
  busySessions: new Set(),
  debouncedRefreshSessions: vi.fn(),
  debouncedReloadMessages: vi.fn(),
  clearMessageTimeout: vi.fn(),
  externalReloadingSessions: new Set(),
}))

vi.mock('@/stores/streaming', () => {
  const state = {
    streamingMessageId: null as string | null,
    childSessionStreaming: {} as Record<string, any>,
    setStreaming: vi.fn(),
    clearStreaming: vi.fn(),
    setChildStreaming: vi.fn(),
  }
  return {
    useStreamingStore: Object.assign(
      (sel: (s: typeof state) => unknown) => sel(state),
      { 
        getState: () => state,
        setState: (update: Partial<typeof state> | ((s: typeof state) => Partial<typeof state>)) => {
          const changes = typeof update === 'function' ? update(state) : update
          Object.assign(state, changes)
        },
      },
    ),
    childStreamingBuffers: new Map(),
    childPartTypes: new Map(),
    scheduleChildStreamingFlush: vi.fn(),
    cleanupChildSession: vi.fn(),
    hasBufferedContent: vi.fn(() => false),
  }
})

vi.mock('@/stores/session-utils', () => ({
  workspacePathsMatch: vi.fn((a: string, b: string) => a === b),
}))

// Stub localStorage
vi.stubGlobal('localStorage', {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

// Stub document.hasFocus
vi.stubGlobal('document', { ...document, hasFocus: () => true })

import { createLifecycleHandlers } from '@/stores/session-sse-lifecycle-handlers'
import { selfCreatedSessionIds, busySessions, debouncedRefreshSessions } from '@/stores/session-internals'
import { sessionLookupCache } from '@/stores/session-cache'
import { useStreamingStore } from '@/stores/streaming'

describe('session-sse-lifecycle-handlers', () => {
  let state: Record<string, any>
  let set: ReturnType<typeof vi.fn>
  let get: () => typeof state
  let handlers: ReturnType<typeof createLifecycleHandlers>

  beforeEach(() => {
    vi.clearAllMocks()
    state = {
      activeSessionId: 'session-1',
      sessions: [],
      highlightedSessionIds: [],
      messageQueue: [],
      pendingQuestions: [],
      pendingPermissions: [],
      sendMessage: vi.fn(),
      setActiveSession: vi.fn(),
      loadChildSessionMessages: vi.fn(),
    }
    set = vi.fn((fn: any) => {
      if (typeof fn === 'function') {
        Object.assign(state, fn(state))
      } else {
        Object.assign(state, fn)
      }
    })
    get = () => state
    handlers = createLifecycleHandlers(set, get)
  })

  it('handleSessionCreated ignores self-created sessions', () => {
    selfCreatedSessionIds.add('sess-new')
    handlers.handleSessionCreated({
      sessionId: 'sess-new',
      type: 'session.created',
    } as any)
    expect(debouncedRefreshSessions).not.toHaveBeenCalled()
    expect(selfCreatedSessionIds.has('sess-new')).toBe(false)
  })

  it('handleSessionCreated triggers refresh for external sessions', async () => {
    handlers.handleSessionCreated({
      sessionId: 'sess-ext',
      type: 'session.created',
    } as any)
    // Wait for the async API check to resolve
    await vi.waitFor(() => {
      expect(debouncedRefreshSessions).toHaveBeenCalled()
    })
    expect(state.highlightedSessionIds).toContain('sess-ext')
  })

  it('handleSessionBusy adds session to busySessions set', () => {
    handlers.handleSessionBusy({ sessionId: 'sess-1', type: 'session.busy' } as any)
    expect(busySessions.has('sess-1')).toBe(true)
  })

  it('handleSessionIdle preserves streaming when pendingQuestion exists', () => {
    state.activeSessionId = 'sess-1'
    state.pendingQuestions = [
      {
        questionId: 'q-1',
        toolCallId: 'tc-1',
        messageId: 'msg-1',
        questions: [],
      },
    ]
    useStreamingStore.setState({ streamingMessageId: 'msg-1' })

    const clearStreamingSpy = vi.spyOn(useStreamingStore.getState(), 'clearStreaming')

    handlers.handleSessionIdle({ sessionId: 'sess-1', type: 'session.idle' } as any)

    // Should NOT clear streaming when question is pending
    expect(clearStreamingSpy).not.toHaveBeenCalled()
  })

  it('handleSessionIdle preserves streaming when pendingPermission exists', () => {
    state.activeSessionId = 'sess-1'
    state.pendingPermissions = [
      {
        permission: {
          id: 'perm-1',
          sessionID: 'sess-1',
          permission: 'write',
          patterns: ['/test'],
        },
        childSessionId: null,
      },
    ]
    useStreamingStore.setState({ streamingMessageId: 'msg-1' })

    const clearStreamingSpy = vi.spyOn(useStreamingStore.getState(), 'clearStreaming')

    handlers.handleSessionIdle({ sessionId: 'sess-1', type: 'session.idle' } as any)

    // Should NOT clear streaming when permission is pending
    expect(clearStreamingSpy).not.toHaveBeenCalled()
  })

  it('handleSessionIdle clears active streaming when only another session owns pending approval', () => {
    state.activeSessionId = 'sess-2'
    state.sessions = [
      { id: 'sess-1', messages: [] },
      { id: 'sess-2', messages: [] },
    ]
    state.pendingPermissions = [
      {
        permission: {
          id: 'perm-1',
          sessionID: 'sess-1',
          permission: 'write',
          patterns: ['/test'],
        },
        childSessionId: null,
        ownerSessionId: 'sess-1',
      },
    ]
    useStreamingStore.setState({ streamingMessageId: 'msg-2' })
    sessionLookupCache.set('sess-2', {
      id: 'sess-2',
      messages: [{ id: 'msg-2', isStreaming: true, content: '', parts: [], role: 'assistant', timestamp: new Date(), sessionId: 'sess-2' }],
      updatedAt: new Date(),
    } as any)

    const clearStreamingSpy = vi.spyOn(useStreamingStore.getState(), 'clearStreaming')

    handlers.handleSessionIdle({ sessionId: 'sess-2', type: 'session.idle' } as any)

    expect(clearStreamingSpy).toHaveBeenCalled()
  })

  it('handleSessionIdle preserves streaming when buffer has content', async () => {
    state.activeSessionId = 'sess-1'
    state.pendingQuestions = []
    state.pendingPermissions = []
    useStreamingStore.setState({ streamingMessageId: 'msg-1' })
    sessionLookupCache.set('sess-1', {
      id: 'sess-1',
      messages: [{ id: 'msg-1', isStreaming: true, content: '', parts: [], role: 'assistant', timestamp: new Date(), sessionId: 'sess-1' }],
      updatedAt: new Date(),
    } as any)

    const { hasBufferedContent } = await import('@/stores/streaming')
    vi.mocked(hasBufferedContent).mockReturnValue(true)

    const clearStreamingSpy = vi.spyOn(useStreamingStore.getState(), 'clearStreaming')

    handlers.handleSessionIdle({ sessionId: 'sess-1', type: 'session.idle' } as any)

    expect(hasBufferedContent).toHaveBeenCalled()
    expect(clearStreamingSpy).not.toHaveBeenCalled()
  })

  it('handleSessionIdle clears streaming when buffer is empty', async () => {
    state.activeSessionId = 'sess-1'
    state.pendingQuestions = []
    state.pendingPermissions = []
    useStreamingStore.setState({ streamingMessageId: 'msg-1' })
    sessionLookupCache.set('sess-1', {
      id: 'sess-1',
      messages: [{ id: 'msg-1', isStreaming: true, content: '', parts: [], role: 'assistant', timestamp: new Date(), sessionId: 'sess-1' }],
      updatedAt: new Date(),
    } as any)

    const { hasBufferedContent } = await import('@/stores/streaming')
    vi.mocked(hasBufferedContent).mockReturnValue(false)

    const clearStreamingSpy = vi.spyOn(useStreamingStore.getState(), 'clearStreaming')

    handlers.handleSessionIdle({ sessionId: 'sess-1', type: 'session.idle' } as any)

    expect(hasBufferedContent).toHaveBeenCalled()
    expect(clearStreamingSpy).toHaveBeenCalled()
  })

  it('handleSessionStatus preserves streaming during retry', () => {
    state.activeSessionId = 'sess-1'
    useStreamingStore.setState({ streamingMessageId: 'msg-1' })

    const clearStreamingSpy = vi.spyOn(useStreamingStore.getState(), 'clearStreaming')

    handlers.handleSessionStatus({
      sessionId: 'sess-1',
      status: {
        type: 'retry',
        attempt: 1,
        message: 'Rate limit, retrying...',
        next: Date.now() + 5000,
      },
    } as any)

    // Should NOT clear streaming during retry (OpenCode will continue after retry)
    expect(clearStreamingSpy).not.toHaveBeenCalled()
    // Should set sessionError to show retry status
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      sessionError: expect.objectContaining({
        error: expect.objectContaining({
          name: 'RetryError',
        }),
      }),
    }))
  })

  it('handleSessionStatus idle keeps pending permissions and questions for active approvals', () => {
    state.activeSessionId = 'sess-1'
    state.pendingPermissions = [
      {
        permission: {
          id: 'perm-1',
          sessionID: 'sess-1',
          permission: 'bash',
          patterns: ['ls'],
        },
        childSessionId: null,
        ownerSessionId: 'sess-1',
      },
    ]
    state.pendingQuestions = [
      {
        questionId: 'question-1',
        toolCallId: 'tool-question-1',
        messageId: 'msg-1',
        sessionId: 'sess-1',
        questions: [{ question: 'Continue?', options: [] }],
      },
    ]

    handlers.handleSessionStatus({
      sessionId: 'sess-1',
      status: { type: 'idle' },
    } as any)

    expect(state.pendingPermissions).toEqual([
      expect.objectContaining({
        permission: expect.objectContaining({ id: 'perm-1' }),
      }),
    ])
    expect(state.pendingQuestions).toEqual([
      expect.objectContaining({
        questionId: 'question-1',
      }),
    ])
  })

  it('does not clean up child session when child permission is still pending', async () => {
    state.pendingPermissions = [
      {
        permission: {
          id: 'perm-child-1',
          sessionID: 'child-1',
          permission: 'bash',
          patterns: ['ps'],
        },
        childSessionId: 'child-1',
      },
    ]
    useStreamingStore.setState({
      childSessionStreaming: {
        'child-1': {
          sessionId: 'child-1',
          text: '',
          reasoning: '',
          isStreaming: true,
        },
      },
    })

    const { cleanupChildSession } = await import('@/stores/streaming')

    handlers.handleSessionStatus({
      sessionId: 'child-1',
      status: { type: 'idle' },
    } as any)

    expect(cleanupChildSession).not.toHaveBeenCalled()
    expect(state.loadChildSessionMessages).not.toHaveBeenCalled()
    expect(state.pendingPermissions).toEqual([
      expect.objectContaining({
        childSessionId: 'child-1',
      }),
    ])
  })

  it('does not clean up known child session when child streaming state is already gone but permission is pending', async () => {
    state.sessions = [
      { id: 'child-1', parentID: 'session-1', messages: [] },
    ]
    state.pendingPermissions = [
      {
        permission: {
          id: 'perm-child-2',
          sessionID: 'child-1',
          permission: 'edit',
          patterns: ['notes.md'],
        },
        childSessionId: 'child-1',
      },
    ]
    useStreamingStore.setState({ childSessionStreaming: {} })

    const { cleanupChildSession } = await import('@/stores/streaming')

    handlers.handleSessionStatus({
      sessionId: 'child-1',
      status: { type: 'idle' },
    } as any)

    expect(cleanupChildSession).not.toHaveBeenCalled()
    expect(state.loadChildSessionMessages).not.toHaveBeenCalled()
    expect(state.pendingPermissions).toEqual([
      expect.objectContaining({
        childSessionId: 'child-1',
      }),
    ])
  })

  it('clearSessionError resets sessionError to null', () => {
    state.sessionError = { error: 'something' }
    handlers.clearSessionError()
    expect(set).toHaveBeenCalledWith({ sessionError: null })
  })

  it('clearHighlightedSession removes the session id', () => {
    state.highlightedSessionIds = ['a', 'b', 'c']
    handlers.clearHighlightedSession('b')
    expect(state.highlightedSessionIds).toEqual(['a', 'c'])
  })
})
