import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const mockGetGitStatus = vi.fn().mockResolvedValue([])
const mockClearCache = vi.fn()

vi.mock('@/lib/git/service', () => ({
  GitService: {
    getInstance: () => ({
      getGitStatus: mockGetGitStatus,
      clearCache: mockClearCache,
    }),
    getStatusColor: vi.fn(() => 'text-green-500'),
    getStatusIcon: vi.fn(() => 'M'),
  },
  GitStatus: {
    MODIFIED: 'modified',
    ADDED: 'added',
    DELETED: 'deleted',
    UNTRACKED: 'untracked',
    STAGED: 'staged',
  },
  normalizePath: (p: string) => p.replace(/\\/g, '/').replace(/\/$/, ''),
  isChildPath: (parent: string, child: string) => child.startsWith(parent + '/'),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: any) => any) => sel({ workspacePath: '/workspace' }),
}))

vi.mock('@/stores/git-settings', () => ({
  useGitSettingsStore: (sel: (s: any) => any) => sel({ pollingInterval: 999999999 }),
}))

// isTauri() returns false in jsdom — web mode branch is exercised
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }))
vi.mock('@/lib/git/manager', () => ({ gitManager: { status: vi.fn() } }))
vi.mock('@/lib/build-config', () => ({ TEAM_REPO_DIR: 'teamclaw-team' }))

import { useGitStatus } from '@/hooks/use-git-status'

// In web mode the hook filters to only files under <workspace>/teamclaw-team/
const TEAM_FILE = 'teamclaw-team/src/file.ts'
const TEAM_FILE_ABS = '/workspace/teamclaw-team/src/file.ts'

describe('useGitStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetGitStatus.mockResolvedValue([])
  })

  it('returns initial state with empty git statuses', async () => {
    const { result } = renderHook(() => useGitStatus())
    await waitFor(() => {
      expect(mockGetGitStatus).toHaveBeenCalled()
    })
    expect(result.current.gitStatuses.size).toBe(0)
    expect(result.current.error).toBeNull()
  })

  it('loads git statuses from service (only teamclaw-team files)', async () => {
    mockGetGitStatus.mockResolvedValue([
      { path: TEAM_FILE, status: 'modified' },
      { path: 'other/file.ts', status: 'modified' }, // outside teamclaw-team — filtered out
    ])
    const { result } = renderHook(() => useGitStatus())
    await waitFor(() => {
      expect(result.current.gitStatuses.size).toBe(1)
    })
    expect(result.current.gitStatuses.has(TEAM_FILE_ABS)).toBe(true)
  })

  it('hasFileChanged returns true for modified files', async () => {
    mockGetGitStatus.mockResolvedValue([
      { path: TEAM_FILE, status: 'modified' },
    ])
    const { result } = renderHook(() => useGitStatus())
    await waitFor(() => {
      expect(result.current.gitStatuses.size).toBe(1)
    })
    expect(result.current.hasFileChanged(TEAM_FILE_ABS)).toBe(true)
    expect(result.current.hasFileChanged('/workspace/teamclaw-team/src/other.ts')).toBe(false)
  })
})
