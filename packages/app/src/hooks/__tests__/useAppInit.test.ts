import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// --- Hoist mocks ---
const {
  mockSetWorkspace,
  mockSetOpenCodeBootstrapped,
  mockSetOpenCodeReady,
  mockIsTauri,
  mockExists,
  mockInvoke,
  mockListen,
  mockLoadTeamShortcutsFile,
  mockLoadCurrentNodeId,
  mockLoadMembers,
} = vi.hoisted(() => ({
  mockSetWorkspace: vi.fn(),
  mockSetOpenCodeBootstrapped: vi.fn(),
  mockSetOpenCodeReady: vi.fn(),
  mockIsTauri: vi.fn(() => false),
  mockExists: vi.fn(),
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
  mockLoadTeamShortcutsFile: vi.fn(),
  mockLoadCurrentNodeId: vi.fn(),
  mockLoadMembers: vi.fn(),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: mockIsTauri,
  openExternalUrl: vi.fn(),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mockExists,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}))

const workspaceState = {
  workspacePath: null as string | null,
  setWorkspace: mockSetWorkspace,
  setOpenCodeBootstrapped: mockSetOpenCodeBootstrapped,
  setOpenCodeReady: mockSetOpenCodeReady,
  openCodeBootstrapped: false,
  openCodeReady: false,
  openPanel: vi.fn(),
  closePanel: vi.fn(),
}

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(workspaceState as unknown as Record<string, unknown>),
}))

const teamModeState = {
  teamMode: false,
  setState: vi.fn(),
}

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector(teamModeState as unknown as Record<string, unknown>),
    {
      getState: () => teamModeState,
      setState: teamModeState.setState,
    },
  ),
}))

const p2pEngineState = {
  init: vi.fn(async () => () => {}),
  fetch: vi.fn(async () => {}),
}

vi.mock('@/stores/p2p-engine', () => ({
  useP2pEngineStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector(p2pEngineState as unknown as Record<string, unknown>),
    {
      getState: () => p2pEngineState,
    },
  ),
}))

vi.mock('@/stores/channels', () => ({
  useChannelsStore: () => ({
    autoStartEnabledGateways: vi.fn(),
    loadConfig: vi.fn().mockResolvedValue(undefined),
    stopAllAndReset: vi.fn().mockResolvedValue(undefined),
    keepAliveCheck: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@/stores/git-repos', () => ({
  useGitReposStore: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    syncAll: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@/stores/team-members', () => ({
  useTeamMembersStore: {
    getState: () => ({
      loadCurrentNodeId: mockLoadCurrentNodeId,
      loadMembers: mockLoadMembers,
    }),
  },
}))

vi.mock('@/lib/team-shortcuts', () => ({
  loadTeamShortcutsFile: mockLoadTeamShortcutsFile,
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      layoutMode: 'task',
      toggleLayoutMode: vi.fn(),
    }),
}))

vi.mock('@/stores/deps', () => ({
  useDepsStore: () => ({
    dependencies: [],
    checked: false,
    checkDependencies: vi.fn().mockResolvedValue([]),
  }),
  getSetupDecision: () => 'skip',
  markSetupCompleted: vi.fn(),
}))

vi.mock('@/stores/telemetry', () => ({
  useTelemetryStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      consent: 'undecided',
      init: vi.fn(),
      isInitialized: false,
    }),
}))

vi.mock('@/lib/opencode/sdk-client', () => ({
  initOpenCodeClient: vi.fn(),
}))

vi.mock('@/lib/opencode/preloader', () => ({
  startOpenCode: vi.fn().mockResolvedValue({ url: 'http://localhost:13141' }),
  hasPreloadFor: vi.fn(() => false),
  waitForOpenCodeBootstrapped: vi.fn().mockResolvedValue({ url: 'http://localhost:13141' }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  mockIsTauri.mockReturnValue(false)
  mockExists.mockResolvedValue(true)
  mockInvoke.mockResolvedValue(null)
  mockListen.mockResolvedValue(vi.fn())
  mockLoadTeamShortcutsFile.mockResolvedValue([])
  mockLoadCurrentNodeId.mockResolvedValue(undefined)
  mockLoadMembers.mockResolvedValue(undefined)
  workspaceState.workspacePath = null
  workspaceState.openCodeBootstrapped = false
  workspaceState.openCodeReady = false
  teamModeState.teamMode = false
  teamModeState.setState.mockClear()
  p2pEngineState.init = vi.fn(async () => () => {})
  p2pEngineState.fetch = vi.fn(async () => {})
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useOpenCodeInit', () => {
  it('returns openCodeError as null initially', async () => {
    const { useOpenCodeInit } = await import('@/hooks/useAppInit')
    const { result } = renderHook(() => useOpenCodeInit())
    expect(result.current.openCodeError).toBeNull()
  })

  it('exposes setOpenCodeError function', async () => {
    const { useOpenCodeInit } = await import('@/hooks/useAppInit')
    const { result } = renderHook(() => useOpenCodeInit())
    expect(typeof result.current.setOpenCodeError).toBe('function')
  })

  it('restores the last workspace when one is saved', async () => {
    localStorage.setItem('teamclaw-workspace-path', '/tmp/teamclaw-last')

    const { useOpenCodeInit } = await import('@/hooks/useAppInit')
    const { result } = renderHook(() => useOpenCodeInit())

    await waitFor(() => {
      expect(mockSetWorkspace).toHaveBeenCalledWith('/tmp/teamclaw-last')
      expect(result.current.initialWorkspaceResolved).toBe(true)
    })
  })

  it('clears a saved workspace when it no longer exists in Tauri', async () => {
    mockIsTauri.mockReturnValue(true)
    mockExists.mockResolvedValue(false)
    localStorage.setItem('teamclaw-workspace-path', '/tmp/missing-workspace')

    const { useOpenCodeInit } = await import('@/hooks/useAppInit')
    const { result } = renderHook(() => useOpenCodeInit())

    await waitFor(() => {
      expect(mockSetWorkspace).not.toHaveBeenCalled()
      expect(localStorage.getItem('teamclaw-workspace-path')).toBeNull()
      expect(result.current.initialWorkspaceResolved).toBe(true)
    })
  })
})

describe('useTauriBodyClass', () => {
  it('does not add tauri class in non-Tauri environment', async () => {
    const { useTauriBodyClass } = await import('@/hooks/useAppInit')
    renderHook(() => useTauriBodyClass())
    expect(document.documentElement.classList.contains('tauri')).toBe(false)
  })
})

describe('useLayoutModeShortcut', () => {
  it('renders without error', async () => {
    const { useLayoutModeShortcut } = await import('@/hooks/useAppInit')
    const { result } = renderHook(() => useLayoutModeShortcut())
    expect(result.current).toBeUndefined()
  })
})

describe('useSetupGuide', () => {
  it('returns showSetupGuide as false initially', async () => {
    const { useSetupGuide } = await import('@/hooks/useAppInit')
    const { result } = renderHook(() => useSetupGuide(false))
    expect(result.current.showSetupGuide).toBe(false)
    expect(result.current.dependencies).toEqual([])
  })
})

describe('useTelemetryConsent', () => {
  it('returns showConsentDialog as false initially', async () => {
    const { useTelemetryConsent } = await import('@/hooks/useAppInit')
    const { result } = renderHook(() => useTelemetryConsent(false))
    expect(result.current.showConsentDialog).toBe(false)
  })
})

describe('useGitReposInit', () => {
  it('hydrates current member roles when loading team shortcuts on startup', async () => {
    mockIsTauri.mockReturnValue(true)
    workspaceState.workspacePath = '/workspace-team'
    workspaceState.openCodeReady = true

    const { useGitReposInit } = await import('@/hooks/useAppInit')
    renderHook(() => useGitReposInit())

    await waitFor(() => {
      expect(mockLoadCurrentNodeId).toHaveBeenCalled()
      expect(mockLoadMembers).toHaveBeenCalled()
    })
  })

  it('refreshes current member shortcut roles when member manifest files change', async () => {
    mockIsTauri.mockReturnValue(true)
    workspaceState.workspacePath = '/workspace-team'
    workspaceState.openCodeReady = true

    const { useGitReposInit } = await import('@/hooks/useAppInit')
    renderHook(() => useGitReposInit())

    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith('file-change', expect.any(Function))
    })

    mockLoadCurrentNodeId.mockClear()
    mockLoadMembers.mockClear()
    vi.useFakeTimers()

    const fileChangeCallback = mockListen.mock.calls.find(
      ([eventName]) => eventName === 'file-change',
    )?.[1] as ((event: { payload: { path: string; kind: string } }) => void) | undefined

    expect(fileChangeCallback).toBeDefined()
    fileChangeCallback?.({
      payload: {
        path: '/workspace-team/teamclaw-team/_meta/members.json',
        kind: 'modify',
      },
    })

    await vi.advanceTimersByTimeAsync(600)

    expect(mockLoadCurrentNodeId).toHaveBeenCalled()
    expect(mockLoadMembers).toHaveBeenCalled()
  })

  it('refreshes current member shortcut roles when team members change', async () => {
    mockIsTauri.mockReturnValue(true)
    workspaceState.workspacePath = '/workspace-team'
    workspaceState.openCodeReady = true

    const { useGitReposInit } = await import('@/hooks/useAppInit')
    renderHook(() => useGitReposInit())

    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith('team:members-changed', expect.any(Function))
    })

    mockLoadCurrentNodeId.mockClear()
    mockLoadMembers.mockClear()

    const membersChangedCallback = mockListen.mock.calls.find(
      ([eventName]) => eventName === 'team:members-changed',
    )?.[1] as (() => void) | undefined

    expect(membersChangedCallback).toBeDefined()
    membersChangedCallback?.()

    await waitFor(() => {
      expect(mockLoadCurrentNodeId).toHaveBeenCalled()
      expect(mockLoadMembers).toHaveBeenCalled()
    })
  })
})

describe('useP2pAutoReconnect', () => {
  it('retries reconnect when team mode becomes active after workspace switch', async () => {
    vi.useFakeTimers()
    mockIsTauri.mockReturnValue(true)
    workspaceState.workspacePath = '/workspace-team'
    workspaceState.openCodeReady = true

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'p2p_sync_status') {
        return { connected: true, role: 'owner' }
      }
      return null
    })

    const { useP2pAutoReconnect } = await import('@/hooks/useAppInit')
    const { rerender } = renderHook(() => useP2pAutoReconnect())

    await vi.advanceTimersByTimeAsync(3100)
    expect(mockInvoke).not.toHaveBeenCalledWith('p2p_reconnect')

    teamModeState.teamMode = true
    rerender()

    await vi.advanceTimersByTimeAsync(3100)

    expect(mockInvoke).toHaveBeenCalledWith('p2p_reconnect')
    expect(teamModeState.setState).toHaveBeenCalledWith({
      p2pConnected: true,
      myRole: 'owner',
    })
    expect(p2pEngineState.init).toHaveBeenCalled()
    expect(p2pEngineState.fetch).toHaveBeenCalled()
  })
})
