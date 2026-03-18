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

vi.mock('@/lib/opencode/client', () => ({
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
      pendingPermission: null,
      pendingPermissionChildSessionId: null,
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
      pendingPermission: null,
      pendingPermissionChildSessionId: null,
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
      pendingPermission: null,
    }))
    const actions = createPermissionActions(set as any, get as any)
    await actions.pollPermissions()
    expect(mockListPermissions).not.toHaveBeenCalled()
  })
})
