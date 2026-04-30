import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Hoisted mocks ---
const mockListSessions = vi.fn()
const mockCreateSession = vi.fn()
const mockArchiveSession = vi.fn()
const mockGetMessages = vi.fn()
const mockGetSession = vi.fn()
const mockGetTodos = vi.fn()
const mockGetSessionDiff = vi.fn()
const mockClearStreaming = vi.fn()

vi.mock('@/lib/opencode/sdk-client', () => ({
  getOpenCodeClient: () => ({
    listSessions: mockListSessions,
    createSession: mockCreateSession,
    archiveSession: mockArchiveSession,
    getMessages: mockGetMessages,
    getSession: mockGetSession,
    getTodos: mockGetTodos,
    getSessionDiff: mockGetSessionDiff,
  }),
}))

vi.mock('@/stores/streaming', () => ({
  useStreamingStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ streamingMessageId: null, streamingContent: '' }),
    {
      getState: () => ({
        streamingMessageId: null,
        streamingContent: '',
        clearStreaming: mockClearStreaming,
        setStreaming: vi.fn(),
      }),
    },
  ),
  cleanupAllChildSessions: vi.fn(),
}))

vi.mock('@/stores/provider', () => ({
  useProviderStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ models: [] }),
    {
      getState: () => ({ models: [] }),
      setState: vi.fn(),
    },
  ),
}))

vi.mock('@/lib/opencode/sdk-sse', () => ({
  clearAllChildSessions: vi.fn(),
}))

vi.mock('@/stores/telemetry', () => ({
  trackEvent: vi.fn(),
}))

// Stub localStorage (jsdom may not provide it for all environments)
vi.stubGlobal('localStorage', {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

import { createLoaderActions } from '@/stores/session-loader'
import { sessionLookupCache } from '@/stores/session-cache'
import { sessionDataCache } from '@/stores/session-data-cache'
import { selfCreatedSessionIds } from '@/stores/session-internals'

describe('session-loader: createLoaderActions', () => {
  let state: Record<string, unknown>
  let set: ReturnType<typeof vi.fn>
  let get: ReturnType<typeof vi.fn>
  let actions: ReturnType<typeof createLoaderActions>

  beforeEach(() => {
    vi.clearAllMocks()
    mockClearStreaming.mockClear()
    vi.mocked(localStorage.getItem).mockReturnValue(null)
    sessionLookupCache.clear()
    sessionDataCache.clear()
    selfCreatedSessionIds.clear()

    state = {
      sessions: [],
      pinnedSessionIds: [],
      activeSessionId: null,
      isLoading: false,
      messageQueue: [],
      pendingPermissions: [],
      pendingQuestions: [],
      pendingQuestionIdsBySession: {},
      sessionStatuses: {},
      todos: [],
      sessionDiff: [],
      error: null,
      isLoadingMore: false,
      hasMoreSessions: false,
      visibleSessionCount: 50,
    }

    set = vi.fn((updater) => {
      if (typeof updater === 'function') {
        const partial = updater(state)
        Object.assign(state, partial)
      } else {
        Object.assign(state, updater)
      }
    })
    get = vi.fn(() => state)
    actions = createLoaderActions(set, get)
  })

  it('loadSessions fetches sessions and sorts by updatedAt descending', async () => {
    const now = Date.now()
    mockListSessions.mockResolvedValue([
      { id: 'older', title: 'Older', time: { created: now - 2000, updated: now - 2000 } },
      { id: 'newer', title: 'Newer', time: { created: now - 1000, updated: now - 1000 } },
    ])

    await actions.loadSessions('/workspace')

    expect(mockListSessions).toHaveBeenCalledWith({ directory: '/workspace', roots: true })
    // Find the set call that contains sessions
    const sessionsCall = set.mock.calls.find(
      (c) => {
        const arg = c[0]
        return typeof arg === 'object' && arg !== null && 'sessions' in arg
      }
    )
    expect(sessionsCall).toBeDefined()
    const sessions = sessionsCall![0].sessions
    expect(sessions).toHaveLength(2)
    expect(sessions[0].id).toBe('newer')
    expect(sessions[1].id).toBe('older')
  })

  it('loadSessions preserves pinned ids that are temporarily missing', async () => {
    const now = Date.now()
    state.currentWorkspacePath = '/workspace'
    state.pinnedSessionIds = ['missing', 'active']
    mockListSessions.mockResolvedValue([
      { id: 'active', title: 'Active', time: { created: now, updated: now } },
    ])

    await actions.loadSessions('/workspace')

    expect(state.pinnedSessionIds).toEqual(['missing', 'active'])
    expect(localStorage.setItem).not.toHaveBeenCalled()
  })

  it('loadSessions preserves pinned ids from other workspaces when switching', async () => {
    const now = Date.now()
    vi.mocked(localStorage.getItem).mockReturnValue(
      JSON.stringify({
        '/workspace-a': ['a-pinned'],
        '/workspace-b': ['b-pinned'],
      }),
    )

    mockListSessions.mockResolvedValue([
      { id: 'b-pinned', title: 'Pinned in B', time: { created: now, updated: now } },
      { id: 'b-other', title: 'Other in B', time: { created: now - 1000, updated: now - 1000 } },
    ])

    await actions.loadSessions('/workspace-b')

    expect(state.pinnedSessionIds).toEqual(['b-pinned'])
    expect(state.currentWorkspacePath).toBe('/workspace-b')
    expect(localStorage.setItem).not.toHaveBeenCalled()
  })

  it('loadSessions filters out archived and child sessions', async () => {
    const now = Date.now()
    mockListSessions.mockResolvedValue([
      { id: 'active', title: 'Active', time: { created: now, updated: now } },
      { id: 'archived', title: 'Archived', time: { created: now, updated: now, archived: now } },
      { id: 'child', title: 'Child', time: { created: now, updated: now }, parentID: 'active' },
    ])

    await actions.loadSessions()

    const sessionsCall = set.mock.calls.find(
      (c) => {
        const arg = c[0]
        return typeof arg === 'object' && arg !== null && 'sessions' in arg
      }
    )
    expect(sessionsCall).toBeDefined()
    const sessions = sessionsCall![0].sessions
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe('active')
  })

  it('loadSessions sets error on failure', async () => {
    mockListSessions.mockRejectedValue(new Error('Network error'))

    await actions.loadSessions()

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Network error',
      isLoading: false,
    }))
  })

  it('resetSessions clears pending activity maps', () => {
    state.pendingQuestionIdsBySession = { 'sess-1': ['question-1'] }
    state.sessionStatuses = { 'sess-1': { type: 'busy' } }

    actions.resetSessions()

    expect(state.pendingQuestionIdsBySession).toEqual({})
    expect(state.sessionStatuses).toEqual({})
  })

  it('createSession calls API, adds session to state, tracks self-created', async () => {
    const now = Date.now()
    mockCreateSession.mockResolvedValue({
      id: 'new-session',
      title: 'New Chat',
      time: { created: now, updated: now },
      directory: '/workspace',
    })

    const result = await actions.createSession()

    expect(mockCreateSession).toHaveBeenCalled()
    expect(result).toBeDefined()
    expect(result!.id).toBe('new-session')
    expect(selfCreatedSessionIds.has('new-session')).toBe(true)
  })

  it('setActiveSession loads messages and sets session as active', async () => {
    const now = Date.now()
    // Pre-populate a session in state
    state.sessions = [{
      id: 'sess-1',
      title: 'Test',
      messages: [],
      createdAt: new Date(now),
      updatedAt: new Date(now),
    }]
    sessionLookupCache.set('sess-1', state.sessions[0] as any)

    mockGetMessages.mockResolvedValue([])
    mockGetSession.mockResolvedValue({
      id: 'sess-1',
      title: 'Test',
      time: { created: now, updated: now },
    })
    mockGetTodos.mockResolvedValue([])
    mockGetSessionDiff.mockResolvedValue([])

    await actions.setActiveSession('sess-1')

    // Should have been called with activeSessionId
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      activeSessionId: 'sess-1',
      isLoading: true,
    }))
    expect(mockGetMessages).toHaveBeenCalledWith('sess-1')
  })

  it('setActiveSession keeps pending permissions so sidebar approval state survives session switches', async () => {
    const now = Date.now()
    state.sessions = [
      {
        id: 'sess-1',
        title: 'Waiting',
        messages: [],
        createdAt: new Date(now),
        updatedAt: new Date(now),
      },
      {
        id: 'sess-2',
        title: 'Target',
        messages: [],
        createdAt: new Date(now),
        updatedAt: new Date(now),
      },
    ]
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

    mockGetMessages.mockResolvedValue([])
    mockGetSession.mockResolvedValue({
      id: 'sess-2',
      title: 'Target',
      time: { created: now, updated: now },
    })
    mockGetTodos.mockResolvedValue([])
    mockGetSessionDiff.mockResolvedValue([])

    await actions.setActiveSession('sess-2')

    expect(state.pendingPermissions).toEqual([
      expect.objectContaining({
        permission: expect.objectContaining({ id: 'perm-1' }),
        ownerSessionId: 'sess-1',
      }),
    ])
  })

  it('archiveSession removes the session from pinned ids', async () => {
    const now = Date.now()
    state.sessions = [{
      id: 'sess-1',
      title: 'Test',
      messages: [],
      createdAt: new Date(now),
      updatedAt: new Date(now),
      directory: '/workspace',
    }]
    state.pinnedSessionIds = ['sess-1']
    state.activeSessionId = 'sess-1'
    mockArchiveSession.mockResolvedValue(undefined)

    await actions.archiveSession('sess-1')

    expect(mockArchiveSession).toHaveBeenCalledWith('sess-1', '/workspace')
    expect(state.pinnedSessionIds).toEqual([])
    expect(localStorage.setItem).toHaveBeenCalled()
    expect(state.activeSessionId).toBeNull()
  })

  it('archiveSession clears streaming state when archiving the active session', async () => {
    const now = Date.now()
    state.sessions = [
      {
        id: 'sess-1',
        title: 'Question session',
        messages: [],
        createdAt: new Date(now),
        updatedAt: new Date(now),
        directory: '/workspace',
      },
      {
        id: 'sess-2',
        title: 'Next session',
        messages: [],
        createdAt: new Date(now - 1),
        updatedAt: new Date(now - 1),
        directory: '/workspace',
      },
    ]
    state.activeSessionId = 'sess-1'
    state.sessionStatus = { type: 'busy' }
    state.pendingQuestionIdsBySession = { 'sess-1': ['question-1'] }
    mockArchiveSession.mockResolvedValue(undefined)

    await actions.archiveSession('sess-1')

    expect(mockClearStreaming).toHaveBeenCalled()
    expect(state.activeSessionId).toBe('sess-2')
    expect(state.sessionStatus).toBeNull()
    expect(state.pendingQuestionIdsBySession).toEqual({})
  })

  it('loadAllSessionMessages refuses to fetch when too many sessions need messages', async () => {
    const now = Date.now()
    mockListSessions.mockResolvedValue(
      Array.from({ length: 31 }, (_, index) => ({
        id: `session-${index}`,
        title: `Session ${index}`,
        time: { created: now - index, updated: now - index },
        directory: '/workspace',
      })),
    )

    await actions.loadAllSessionMessages('/workspace')

    expect(mockListSessions).toHaveBeenCalledWith({ directory: '/workspace', roots: true })
    expect(mockGetMessages).not.toHaveBeenCalled()
    expect(state.dashboardLoading).toBe(false)
    expect(state.dashboardLoadProgress).toEqual({ loaded: 0, total: 31 })
    expect(state.dashboardLoadError).toContain('31 sessions')
  })
})
