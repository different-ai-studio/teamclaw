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

import { useGitStatus } from '@/hooks/use-git-status'

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

  it('loads git statuses from service', async () => {
    mockGetGitStatus.mockResolvedValue([
      { path: 'src/file.ts', status: 'modified' },
    ])
    const { result } = renderHook(() => useGitStatus())
    await waitFor(() => {
      expect(result.current.gitStatuses.size).toBe(1)
    })
    expect(result.current.gitStatuses.has('/workspace/src/file.ts')).toBe(true)
  })

  it('hasFileChanged returns true for modified files', async () => {
    mockGetGitStatus.mockResolvedValue([
      { path: 'src/file.ts', status: 'modified' },
    ])
    const { result } = renderHook(() => useGitStatus())
    await waitFor(() => {
      expect(result.current.gitStatuses.size).toBe(1)
    })
    expect(result.current.hasFileChanged('/workspace/src/file.ts')).toBe(true)
    expect(result.current.hasFileChanged('/workspace/src/other.ts')).toBe(false)
  })
})
