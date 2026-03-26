import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// --- Hoist mocks ---
const { mockSetWorkspace, mockSetOpenCodeReady, mockIsTauri, mockExists } = vi.hoisted(() => ({
  mockSetWorkspace: vi.fn(),
  mockSetOpenCodeReady: vi.fn(),
  mockIsTauri: vi.fn(() => false),
  mockExists: vi.fn(),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: mockIsTauri,
  openExternalUrl: vi.fn(),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mockExists,
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      workspacePath: null,
      setWorkspace: mockSetWorkspace,
      setOpenCodeReady: mockSetOpenCodeReady,
      openCodeReady: false,
      openPanel: vi.fn(),
      closePanel: vi.fn(),
    }),
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

vi.mock('@/lib/opencode/client', () => ({
  initOpenCodeClient: vi.fn(),
}))

vi.mock('@/lib/opencode/preloader', () => ({
  startOpenCode: vi.fn().mockResolvedValue({ url: 'http://localhost:13141' }),
  hasPreloadFor: vi.fn(() => false),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockIsTauri.mockReturnValue(false)
  mockExists.mockResolvedValue(true)
  localStorage.clear()
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
