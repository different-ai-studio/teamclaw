import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, workspaceState, initOpenCodeClientMock, sessionState, sessionSubscribers, busySessionsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  workspaceState: {
    setOpenCodeBootstrapped: vi.fn(),
    setOpenCodeReady: vi.fn(),
  },
  initOpenCodeClientMock: vi.fn(),
  sessionState: {
    sessionStatuses: {},
    pendingPermissions: [],
    pendingQuestions: [],
  },
  sessionSubscribers: new Set<() => void>(),
  busySessionsMock: new Set<string>(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => workspaceState,
  },
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: {
    getState: () => sessionState,
    subscribe: (subscriber: () => void) => {
      sessionSubscribers.add(subscriber)
      return () => sessionSubscribers.delete(subscriber)
    },
  },
}))
vi.mock('@/stores/session-internals', () => ({
  busySessions: busySessionsMock,
}))
vi.mock('../sdk-client', () => ({ initOpenCodeClient: initOpenCodeClientMock }))

describe('OpenCode runtime reload', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    invokeMock.mockReset()
    workspaceState.setOpenCodeBootstrapped.mockReset()
    workspaceState.setOpenCodeReady.mockReset()
    initOpenCodeClientMock.mockReset()
    sessionState.sessionStatuses = {}
    sessionState.pendingPermissions = []
    sessionState.pendingQuestions = []
    sessionSubscribers.clear()
    busySessionsMock.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('deduplicates concurrent reload requests for the same runtime', async () => {
    let resolveStart: (value: { url: string }) => void = () => {}
    invokeMock.mockImplementation((command: string) => {
      if (command === 'stop_opencode') return Promise.resolve(undefined)
      if (command === 'start_opencode') {
        return new Promise((resolve) => {
          resolveStart = resolve as (value: { url: string }) => void
        })
      }
      return Promise.resolve(undefined)
    })

    const { requestOpenCodeRuntimeReload } = await import('../restart')
    const first = requestOpenCodeRuntimeReload('/workspace/project', 'skills-file-change')
    const second = requestOpenCodeRuntimeReload('/workspace/project', 'team-skills-sync')

    await vi.advanceTimersByTimeAsync(500)
    resolveStart({ url: 'http://127.0.0.1:4096' })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'restarted', url: 'http://127.0.0.1:4096' },
      { status: 'restarted', url: 'http://127.0.0.1:4096' },
    ])

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'stop_opencode')).toHaveLength(1)
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'start_opencode')).toHaveLength(1)
  })

  it('does not deduplicate concurrent reload requests for different workspaces', async () => {
    const startResolvers = new Map<string, (value: { url: string }) => void>()
    invokeMock.mockImplementation((command: string, args: { config?: { workspace_path?: string } }) => {
      if (command === 'stop_opencode') return Promise.resolve(undefined)
      if (command === 'start_opencode') {
        const workspacePath = args.config?.workspace_path ?? ''
        return new Promise((resolve) => {
          startResolvers.set(workspacePath, resolve as (value: { url: string }) => void)
        })
      }
      return Promise.resolve(undefined)
    })

    const { requestOpenCodeRuntimeReload } = await import('../restart')
    const first = requestOpenCodeRuntimeReload('/workspace/alpha', 'skills-file-change')
    const second = requestOpenCodeRuntimeReload('/workspace/beta', 'team-skills-sync')

    await vi.advanceTimersByTimeAsync(500)

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'stop_opencode')).toHaveLength(2)
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'start_opencode')).toHaveLength(2)

    startResolvers.get('/workspace/alpha')?.({ url: 'http://127.0.0.1:4096' })
    startResolvers.get('/workspace/beta')?.({ url: 'http://127.0.0.1:4097' })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'restarted', url: 'http://127.0.0.1:4096' },
      { status: 'restarted', url: 'http://127.0.0.1:4097' },
    ])
  })

  it('defers reload requests when defer-if-busy mode finds a busy session', async () => {
    sessionState.sessionStatuses = { 'sess-1': { type: 'busy' } }

    const { requestOpenCodeRuntimeReload, OPENCODE_RUNTIME_RELOAD_DEFERRED_EVENT } = await import('../restart')
    const deferredHandler = vi.fn()
    window.addEventListener(OPENCODE_RUNTIME_RELOAD_DEFERRED_EVENT, deferredHandler, { once: true })

    await expect(
      requestOpenCodeRuntimeReload('/workspace/project', 'skills-file-change', { mode: 'defer-if-busy' }),
    ).resolves.toEqual({
      status: 'deferred',
      workspacePath: '/workspace/project',
      reason: 'skills-file-change',
    })

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'stop_opencode')).toHaveLength(0)
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'start_opencode')).toHaveLength(0)
    expect(deferredHandler).toHaveBeenCalledTimes(1)
    expect((deferredHandler.mock.calls[0][0] as CustomEvent).detail).toEqual({
      workspacePath: '/workspace/project',
      reason: 'skills-file-change',
    })
  })

  it('runs a deferred reload after the session store becomes idle', async () => {
    sessionState.sessionStatuses = { 'sess-1': { type: 'retry', attempt: 1, message: 'retrying', next: 1000 } }
    invokeMock.mockImplementation((command: string) => {
      if (command === 'stop_opencode') return Promise.resolve(undefined)
      if (command === 'start_opencode') return Promise.resolve({ url: 'http://127.0.0.1:4096' })
      return Promise.resolve(undefined)
    })

    const { requestOpenCodeRuntimeReload, OPENCODE_RUNTIME_RELOADED_EVENT } = await import('../restart')
    const reloadedHandler = vi.fn()
    window.addEventListener(OPENCODE_RUNTIME_RELOADED_EVENT, reloadedHandler, { once: true })

    await requestOpenCodeRuntimeReload('/workspace/project', 'skills-file-change', { mode: 'defer-if-busy' })

    sessionState.sessionStatuses = { 'sess-1': { type: 'idle' } }
    sessionSubscribers.forEach((subscriber) => subscriber())
    await vi.advanceTimersByTimeAsync(500)

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'stop_opencode')).toHaveLength(1)
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'start_opencode')).toHaveLength(1)
    expect(reloadedHandler).toHaveBeenCalledTimes(1)
    expect((reloadedHandler.mock.calls[0][0] as CustomEvent).detail).toEqual({
      workspacePath: '/workspace/project',
      reason: 'skills-file-change',
      url: 'http://127.0.0.1:4096',
    })
  })

  it('coalesces repeated deferred requests for the same workspace into one restart', async () => {
    busySessionsMock.add('sess-1')
    invokeMock.mockImplementation((command: string) => {
      if (command === 'stop_opencode') return Promise.resolve(undefined)
      if (command === 'start_opencode') return Promise.resolve({ url: 'http://127.0.0.1:4096' })
      return Promise.resolve(undefined)
    })

    const { requestOpenCodeRuntimeReload, OPENCODE_RUNTIME_RELOADED_EVENT } = await import('../restart')
    const reloadedHandler = vi.fn()
    window.addEventListener(OPENCODE_RUNTIME_RELOADED_EVENT, reloadedHandler, { once: true })

    await expect(
      Promise.all([
        requestOpenCodeRuntimeReload('/workspace/project', 'skills-file-change', { mode: 'defer-if-busy' }),
        requestOpenCodeRuntimeReload('/workspace/project', 'team-skills-sync', { mode: 'defer-if-busy' }),
      ]),
    ).resolves.toEqual([
      { status: 'deferred', workspacePath: '/workspace/project', reason: 'skills-file-change' },
      { status: 'deferred', workspacePath: '/workspace/project', reason: 'team-skills-sync' },
    ])

    busySessionsMock.clear()
    sessionSubscribers.forEach((subscriber) => subscriber())
    await vi.advanceTimersByTimeAsync(500)

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'stop_opencode')).toHaveLength(1)
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'start_opencode')).toHaveLength(1)
    expect((reloadedHandler.mock.calls[0][0] as CustomEvent).detail).toEqual({
      workspacePath: '/workspace/project',
      reason: 'team-skills-sync',
      url: 'http://127.0.0.1:4096',
    })
  })

  it('emits failed event for deferred flush failures without rejecting the subscriber path', async () => {
    busySessionsMock.add('sess-1')
    invokeMock.mockImplementation((command: string) => {
      if (command === 'stop_opencode') return Promise.resolve(undefined)
      if (command === 'start_opencode') return Promise.reject(new Error('restart failed'))
      return Promise.resolve(undefined)
    })

    const { requestOpenCodeRuntimeReload, OPENCODE_RUNTIME_RELOAD_FAILED_EVENT } = await import('../restart')
    const failedHandler = vi.fn()
    window.addEventListener(OPENCODE_RUNTIME_RELOAD_FAILED_EVENT, failedHandler, { once: true })

    await requestOpenCodeRuntimeReload('/workspace/project', 'skills-file-change', { mode: 'defer-if-busy' })

    busySessionsMock.clear()
    expect(() => {
      sessionSubscribers.forEach((subscriber) => subscriber())
    }).not.toThrow()
    await vi.advanceTimersByTimeAsync(500)

    expect(failedHandler).toHaveBeenCalledTimes(1)
    expect((failedHandler.mock.calls[0][0] as CustomEvent).detail).toEqual({
      workspacePath: '/workspace/project',
      reason: 'skills-file-change',
      error: 'restart failed',
    })
  })

  it('treats pending permissions as busy for deferred reloads', async () => {
    sessionState.pendingPermissions = [{ permission: { id: 'perm-1' }, childSessionId: null }]

    const { requestOpenCodeRuntimeReload } = await import('../restart')
    await requestOpenCodeRuntimeReload('/workspace/project', 'skills-permission-change', { mode: 'defer-if-busy' })

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'stop_opencode')).toHaveLength(0)
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'start_opencode')).toHaveLength(0)
  })
})
