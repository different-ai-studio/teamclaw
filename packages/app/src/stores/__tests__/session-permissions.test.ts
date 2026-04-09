import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockReplyPermission = vi.fn().mockResolvedValue(undefined)
const mockListPermissions = vi.fn().mockResolvedValue([])

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
})
