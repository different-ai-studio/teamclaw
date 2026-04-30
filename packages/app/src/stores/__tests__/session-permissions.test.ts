import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockReplyPermission = vi.fn().mockResolvedValue(undefined)
const mockListPermissions = vi.fn().mockResolvedValue([])
const mockGetSession = vi.fn().mockResolvedValue(null)

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('global'),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    setFocus: vi.fn().mockResolvedValue(undefined),
    unminimize: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('@/lib/opencode/sdk-client', () => ({
  getOpenCodeClient: () => ({
    replyPermission: mockReplyPermission,
    listPermissions: mockListPermissions,
    getSession: mockGetSession,
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/lib/notification-service', () => ({
  notificationService: { send: vi.fn() },
}))

vi.mock('@/lib/permission-policy', () => ({
  shouldAutoAuthorize: () => false,
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: Object.assign(
    () => ({ workspacePath: '/test' }),
    { getState: () => ({ workspacePath: '/test' }) },
  ),
}))

vi.mock('@/stores/session-cache', () => ({
  sessionLookupCache: new Map(),
  getSessionById: vi.fn(() => null),
}))

vi.mock('@/stores/session-internals', () => ({
  pendingPermissionBuffer: new Map(),
  attachPermissionToToolCall: vi.fn(() => false),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockListPermissions.mockResolvedValue([])
  mockGetSession.mockResolvedValue(null)
})

describe('createPermissionActions', () => {
  it('creates replyPermission and pollPermissions functions', async () => {
    const { createPermissionActions } = await import('@/stores/session-permissions')
    const set = vi.fn()
    const get = vi.fn(() => ({
      activeSessionId: 'session-1',
      sessions: [],
      pendingPermissions: [],
      setActiveSession: vi.fn(),
    }))
    const actions = createPermissionActions(set as any, get as any)
    expect(typeof actions.replyPermission).toBe('function')
    expect(typeof actions.pollPermissions).toBe('function')
    expect(typeof actions.handlePermissionAsked).toBe('function')
  })

  it('replyPermission calls client.replyPermission with correct reply map', async () => {
    const { createPermissionActions } = await import('@/stores/session-permissions')
    const set = vi.fn()
    const get = vi.fn(() => ({
      activeSessionId: 'session-1',
      sessions: [],
      pendingPermissions: [],
      setActiveSession: vi.fn(),
    }))
    const actions = createPermissionActions(set as any, get as any)
    await actions.replyPermission('perm-1', 'allow')
    expect(mockReplyPermission).toHaveBeenCalledWith('perm-1', { reply: 'once' })
  })

  it('pollPermissions does nothing when no activeSessionId', async () => {
    const { createPermissionActions } = await import('@/stores/session-permissions')
    const set = vi.fn()
    const get = vi.fn(() => ({
      activeSessionId: null,
      sessions: [],
      pendingPermissions: [],
    }))
    const actions = createPermissionActions(set as any, get as any)
    await actions.pollPermissions()
    expect(mockListPermissions).not.toHaveBeenCalled()
  })

  it('should queue multiple permissions without overwriting', async () => {
    const { createPermissionActions } = await import('@/stores/session-permissions')
    const store = {
      activeSessionId: 'session-1',
      sessions: [{ id: 'session-1', title: 'S', messages: [] }],
      pendingPermissions: [] as Array<{ permission: { id: string }; childSessionId: string | null }>,
      setActiveSession: vi.fn(),
    }
    const set = vi.fn((fn: unknown) => {
      if (typeof fn === 'function') {
        Object.assign(store, (fn as (s: typeof store) => Partial<typeof store>)(store))
      } else {
        Object.assign(store, fn)
      }
    })
    const get = vi.fn(() => store)
    const actions = createPermissionActions(set as any, get as any)

    await actions.handlePermissionAsked({
      id: 'perm-1',
      sessionID: 'session-1',
      permission: 'bash',
      patterns: ['ls'],
    })
    await actions.handlePermissionAsked({
      id: 'perm-2',
      sessionID: 'session-1',
      permission: 'write',
      patterns: ['file'],
    })

    expect(store.pendingPermissions).toHaveLength(2)
    expect(store.pendingPermissions.map((e) => e.permission.id)).toEqual(['perm-1', 'perm-2'])
  })

  it('queues child-session tool permissions even when the child session already exists locally', async () => {
    const { createPermissionActions } = await import('@/stores/session-permissions')
    const { getSessionById } = await import('@/stores/session-cache')
    vi.mocked(getSessionById).mockImplementation((sessionId: string) => (
      sessionId === 'parent-1'
        ? ({ id: 'parent-1', title: 'Parent', messages: [] } as any)
        : sessionId === 'child-1'
          ? ({ id: 'child-1', title: 'Child', parentID: 'parent-1', messages: [] } as any)
          : null
    ))

    const store = {
      activeSessionId: 'parent-1',
      sessions: [
        { id: 'parent-1', title: 'Parent', messages: [] },
        { id: 'child-1', title: 'Child', parentID: 'parent-1', messages: [] },
      ],
      pendingPermissions: [] as Array<{ permission: { id: string }; childSessionId: string | null }>,
      setActiveSession: vi.fn(),
    }
    const set = vi.fn((fn: unknown) => {
      if (typeof fn === 'function') {
        Object.assign(store, (fn as (s: typeof store) => Partial<typeof store>)(store))
      } else {
        Object.assign(store, fn)
      }
    })
    const get = vi.fn(() => store)
    const actions = createPermissionActions(set as any, get as any)

    await actions.handlePermissionAsked({
      id: 'perm-child-1',
      sessionID: 'child-1',
      permission: 'edit',
      patterns: ['notes.md'],
      tool: {
        messageID: 'msg-1',
        callID: 'tool-1',
      },
    } as any)

    expect(store.pendingPermissions).toHaveLength(1)
    expect(store.pendingPermissions[0]).toMatchObject({
      childSessionId: 'child-1',
      permission: { id: 'perm-child-1' },
    })
  })

  it('does not assign unresolved unknown child-session permissions to the active session', async () => {
    const { createPermissionActions } = await import('@/stores/session-permissions')
    const { getSessionById } = await import('@/stores/session-cache')
    vi.mocked(getSessionById).mockReturnValue(null)
    mockGetSession.mockRejectedValue(new Error('not found'))

    const store = {
      activeSessionId: 'parent-1',
      sessions: [{ id: 'parent-1', title: 'Parent', messages: [] }],
      pendingPermissions: [] as Array<{
        permission: { id: string; sessionID: string };
        childSessionId: string | null;
        ownerSessionId?: string | null;
      }>,
      setActiveSession: vi.fn(),
    }
    const set = vi.fn((fn: unknown) => {
      if (typeof fn === 'function') {
        Object.assign(store, (fn as (s: typeof store) => Partial<typeof store>)(store))
      } else {
        Object.assign(store, fn)
      }
    })
    const get = vi.fn(() => store)
    const actions = createPermissionActions(set as any, get as any)

    await actions.handlePermissionAsked({
      id: 'perm-child-unknown',
      sessionID: 'child-unknown',
      permission: 'bash',
      patterns: ['whoami'],
      tool: {
        messageID: 'msg-1',
        callID: 'tool-1',
      },
    } as any)

    await vi.waitFor(() => {
      expect(mockGetSession).toHaveBeenCalledWith('child-unknown')
    })
    expect(store.pendingPermissions).toEqual([])
  })

  it('resolves unknown child-session permission owners from the API before showing them', async () => {
    const { createPermissionActions } = await import('@/stores/session-permissions')
    const { getSessionById } = await import('@/stores/session-cache')
    vi.mocked(getSessionById).mockReturnValue(null)
    mockGetSession.mockImplementation((sessionId: string) => {
      if (sessionId === 'child-unknown') {
        return Promise.resolve({ id: 'child-unknown', parentID: 'parent-1', time: {} })
      }
      if (sessionId === 'parent-1') {
        return Promise.resolve({ id: 'parent-1', time: {} })
      }
      return Promise.reject(new Error('not found'))
    })

    const store = {
      activeSessionId: 'parent-1',
      sessions: [{ id: 'parent-1', title: 'Parent', messages: [] }],
      pendingPermissions: [] as Array<{
        permission: { id: string; sessionID: string };
        childSessionId: string | null;
        ownerSessionId?: string | null;
      }>,
      setActiveSession: vi.fn(),
    }
    const set = vi.fn((fn: unknown) => {
      if (typeof fn === 'function') {
        Object.assign(store, (fn as (s: typeof store) => Partial<typeof store>)(store))
      } else {
        Object.assign(store, fn)
      }
    })
    const get = vi.fn(() => store)
    const actions = createPermissionActions(set as any, get as any)

    await actions.handlePermissionAsked({
      id: 'perm-child-unknown',
      sessionID: 'child-unknown',
      permission: 'bash',
      patterns: ['whoami'],
      tool: {
        messageID: 'msg-1',
        callID: 'tool-1',
      },
    } as any)

    await vi.waitFor(() => {
      expect(store.pendingPermissions).toHaveLength(1)
    })
    expect(store.pendingPermissions[0]).toMatchObject({
      childSessionId: 'child-unknown',
      ownerSessionId: 'parent-1',
      permission: { id: 'perm-child-unknown', sessionID: 'child-unknown' },
    })
  })

  it('queues parent tool permissions so sidebar activity can show waiting state', async () => {
    const { createPermissionActions } = await import('@/stores/session-permissions')
    const store = {
      activeSessionId: 'session-1',
      sessions: [{ id: 'session-1', title: 'S', messages: [] }],
      pendingPermissions: [] as Array<{ permission: { id: string; sessionID: string }; childSessionId: string | null }>,
      setActiveSession: vi.fn(),
    }
    const set = vi.fn((fn: unknown) => {
      if (typeof fn === 'function') {
        Object.assign(store, (fn as (s: typeof store) => Partial<typeof store>)(store))
      } else {
        Object.assign(store, fn)
      }
    })
    const get = vi.fn(() => store)
    const actions = createPermissionActions(set as any, get as any)

    await actions.handlePermissionAsked({
      id: 'perm-parent-tool',
      sessionID: 'session-1',
      permission: 'bash',
      patterns: ['ls'],
      tool: {
        messageID: 'msg-1',
        callID: 'tool-1',
      },
    } as any)

    expect(store.pendingPermissions).toHaveLength(1)
    expect(store.pendingPermissions[0]).toMatchObject({
      childSessionId: null,
      permission: { id: 'perm-parent-tool', sessionID: 'session-1' },
    })
  })

  it('pollPermissions queues all outstanding child permissions instead of only the first one', async () => {
    const { createPermissionActions } = await import('@/stores/session-permissions')
    const { getSessionById } = await import('@/stores/session-cache')
    vi.mocked(getSessionById).mockImplementation((sessionId: string) => (
      sessionId === 'parent-1'
        ? ({ id: 'parent-1', title: 'Parent', messages: [] } as any)
        : sessionId === 'child-1'
          ? ({ id: 'child-1', title: 'Child', parentID: 'parent-1', messages: [] } as any)
          : sessionId === 'child-2'
            ? ({ id: 'child-2', title: 'Child 2', parentID: 'parent-1', messages: [] } as any)
            : null
    ))
    mockListPermissions.mockResolvedValue([
      {
        id: 'perm-child-1',
        sessionID: 'child-1',
        permission: 'edit',
        patterns: ['a.md'],
        tool: { messageID: 'msg-1', callID: 'tool-1' },
      },
      {
        id: 'perm-child-2',
        sessionID: 'child-2',
        permission: 'write',
        patterns: ['b.md'],
        tool: { messageID: 'msg-2', callID: 'tool-2' },
      },
    ])

    const store = {
      activeSessionId: 'parent-1',
      sessions: [
        { id: 'parent-1', title: 'Parent', messages: [] },
        { id: 'child-1', title: 'Child', parentID: 'parent-1', messages: [] },
        { id: 'child-2', title: 'Child 2', parentID: 'parent-1', messages: [] },
      ],
      pendingPermissions: [] as Array<{ permission: { id: string }; childSessionId: string | null }>,
      setActiveSession: vi.fn(),
    }
    const set = vi.fn((fn: unknown) => {
      if (typeof fn === 'function') {
        Object.assign(store, (fn as (s: typeof store) => Partial<typeof store>)(store))
      } else {
        Object.assign(store, fn)
      }
    })
    const get = vi.fn(() => store)
    const actions = createPermissionActions(set as any, get as any)

    await actions.pollPermissions()

    expect(store.pendingPermissions.map((entry) => entry.permission.id)).toEqual([
      'perm-child-1',
      'perm-child-2',
    ])
  })

  it('pollPermissions queues parent tool permissions so sidebar can show waiting state after returning to a session', async () => {
    const { createPermissionActions } = await import('@/stores/session-permissions')
    const { attachPermissionToToolCall } = await import('@/stores/session-internals')
    vi.mocked(attachPermissionToToolCall).mockReturnValue(true)
    mockListPermissions.mockResolvedValue([
      {
        id: 'perm-parent-polled',
        sessionID: 'session-1',
        permission: 'bash',
        patterns: ['ls'],
        tool: { messageID: 'msg-1', callID: 'tool-1' },
      },
    ])

    const store = {
      activeSessionId: 'session-1',
      sessions: [{ id: 'session-1', title: 'S', messages: [] }],
      pendingPermissions: [] as Array<{
        permission: { id: string; sessionID: string };
        childSessionId: string | null;
        ownerSessionId?: string | null;
      }>,
      setActiveSession: vi.fn(),
    }
    const set = vi.fn((fn: unknown) => {
      if (typeof fn === 'function') {
        Object.assign(store, (fn as (s: typeof store) => Partial<typeof store>)(store))
      } else {
        Object.assign(store, fn)
      }
    })
    const get = vi.fn(() => store)
    const actions = createPermissionActions(set as any, get as any)

    await actions.pollPermissions()

    expect(store.pendingPermissions[0]).toMatchObject({
      childSessionId: null,
      ownerSessionId: 'session-1',
      permission: { id: 'perm-parent-polled', sessionID: 'session-1' },
    })
  })

  it('pollPermissions ignores unresolved stale child permissions instead of assigning them to the active session', async () => {
    const { createPermissionActions } = await import('@/stores/session-permissions')
    const { getSessionById } = await import('@/stores/session-cache')
    vi.mocked(getSessionById).mockReturnValue(null)
    mockGetSession.mockRejectedValue(new Error('not found'))
    mockListPermissions.mockResolvedValue([
      {
        id: 'perm-stale-child',
        sessionID: 'deleted-child',
        permission: 'bash',
        patterns: ['ps'],
        tool: { messageID: 'msg-1', callID: 'tool-1' },
      },
    ])

    const store = {
      activeSessionId: 'new-session',
      sessions: [{ id: 'new-session', title: 'New', messages: [] }],
      pendingPermissions: [] as Array<{
        permission: { id: string; sessionID: string };
        childSessionId: string | null;
        ownerSessionId?: string | null;
      }>,
      setActiveSession: vi.fn(),
    }
    const set = vi.fn((fn: unknown) => {
      if (typeof fn === 'function') {
        Object.assign(store, (fn as (s: typeof store) => Partial<typeof store>)(store))
      } else {
        Object.assign(store, fn)
      }
    })
    const get = vi.fn(() => store)
    const actions = createPermissionActions(set as any, get as any)

    await actions.pollPermissions()

    expect(mockGetSession).toHaveBeenCalledWith('deleted-child')
    expect(store.pendingPermissions).toEqual([])
  })

  it('pollPermissions ignores child permissions whose parent session is archived', async () => {
    const { createPermissionActions } = await import('@/stores/session-permissions')
    const { getSessionById } = await import('@/stores/session-cache')
    vi.mocked(getSessionById).mockReturnValue(null)
    mockGetSession.mockImplementation((sessionId: string) => {
      if (sessionId === 'deleted-child') {
        return Promise.resolve({ id: 'deleted-child', parentID: 'deleted-parent', time: {} })
      }
      if (sessionId === 'deleted-parent') {
        return Promise.resolve({ id: 'deleted-parent', time: { archived: Date.now() } })
      }
      return Promise.reject(new Error('not found'))
    })
    mockListPermissions.mockResolvedValue([
      {
        id: 'perm-archived-parent',
        sessionID: 'deleted-child',
        permission: 'bash',
        patterns: ['ps'],
        tool: { messageID: 'msg-1', callID: 'tool-1' },
      },
    ])

    const store = {
      activeSessionId: 'new-session',
      sessions: [{ id: 'new-session', title: 'New', messages: [] }],
      pendingPermissions: [] as Array<{
        permission: { id: string; sessionID: string };
        childSessionId: string | null;
        ownerSessionId?: string | null;
      }>,
      setActiveSession: vi.fn(),
    }
    const set = vi.fn((fn: unknown) => {
      if (typeof fn === 'function') {
        Object.assign(store, (fn as (s: typeof store) => Partial<typeof store>)(store))
      } else {
        Object.assign(store, fn)
      }
    })
    const get = vi.fn(() => store)
    const actions = createPermissionActions(set as any, get as any)

    await actions.pollPermissions()

    expect(mockGetSession).toHaveBeenCalledWith('deleted-child')
    expect(mockGetSession).toHaveBeenCalledWith('deleted-parent')
    expect(store.pendingPermissions).toEqual([])
  })

  it('pollPermissions removes existing stale pending permissions that cannot be resolved', async () => {
    const { createPermissionActions } = await import('@/stores/session-permissions')
    const { getSessionById } = await import('@/stores/session-cache')
    vi.mocked(getSessionById).mockReturnValue(null)
    mockGetSession.mockRejectedValue(new Error('not found'))
    mockListPermissions.mockResolvedValue([
      {
        id: 'perm-stale-child',
        sessionID: 'deleted-child',
        permission: 'bash',
        patterns: ['ps'],
        tool: { messageID: 'msg-1', callID: 'tool-1' },
      },
    ])

    const store = {
      activeSessionId: 'new-session',
      sessions: [{ id: 'new-session', title: 'New', messages: [] }],
      pendingPermissions: [
        {
          permission: {
            id: 'perm-stale-child',
            sessionID: 'deleted-child',
            permission: 'bash',
            patterns: ['ps'],
          },
          childSessionId: 'deleted-child',
          ownerSessionId: 'new-session',
        },
      ] as Array<{
        permission: { id: string; sessionID: string; permission: string; patterns: string[] };
        childSessionId: string | null;
        ownerSessionId?: string | null;
      }>,
      setActiveSession: vi.fn(),
    }
    const set = vi.fn((fn: unknown) => {
      if (typeof fn === 'function') {
        Object.assign(store, (fn as (s: typeof store) => Partial<typeof store>)(store))
      } else {
        Object.assign(store, fn)
      }
    })
    const get = vi.fn(() => store)
    const actions = createPermissionActions(set as any, get as any)

    await actions.pollPermissions()

    expect(store.pendingPermissions).toEqual([])
  })
})
