import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('@/lib/opencode/config', () => ({
  addCustomProviderToConfig: vi.fn(),
  getCustomProviderConfig: vi.fn(),
  removeCustomProviderFromConfig: vi.fn(),
}))

vi.mock('@/stores/provider', () => ({
  useProviderStore: { getState: () => ({}) },
}))

vi.mock('@/lib/build-config', () => ({
  appShortName: 'teamclaw',
  TEAM_REPO_DIR: 'teamclaw-team',
  buildConfig: { team: { llm: { models: [] }, lockLlmConfig: false } },
}))

beforeEach(() => {
  mockInvoke.mockReset()
})

describe('loadTeamGitFileSyncStatus', () => {
  it('maps untracked → new, modified/added/deleted/renamed/copied → modified, drops ignored', async () => {
    mockInvoke.mockResolvedValueOnce({
      branch: 'main',
      clean: false,
      files: [
        { path: 'a.md', status: 'untracked', staged: false },
        { path: 'b.md', status: 'modified', staged: false },
        { path: 'c.md', status: 'added', staged: true },
        { path: 'd.md', status: 'deleted', staged: false },
        { path: 'e.md', status: 'renamed', staged: true },
        { path: 'f.md', status: 'copied', staged: true },
        { path: 'g.md', status: 'ignored', staged: false },
        { path: 'h.md', status: 'unknown', staged: false },
      ],
    })

    const { useTeamModeStore } = await import('@/stores/team-mode')
    await useTeamModeStore.getState().loadTeamGitFileSyncStatus('/ws')

    expect(mockInvoke).toHaveBeenCalledWith('git_status', { path: '/ws/teamclaw-team' })
    const map = useTeamModeStore.getState().teamGitFileSyncStatusMap
    expect(map).toEqual({
      'a.md': 'new',
      'b.md': 'modified',
      'c.md': 'modified',
      'd.md': 'modified',
      'e.md': 'modified',
      'f.md': 'modified',
    })
  })

  it('swallows errors and leaves map unchanged', async () => {
    const { useTeamModeStore } = await import('@/stores/team-mode')
    useTeamModeStore.setState({ teamGitFileSyncStatusMap: { 'x.md': 'modified' } })

    mockInvoke.mockRejectedValueOnce(new Error('no .git'))

    await expect(
      useTeamModeStore.getState().loadTeamGitFileSyncStatus('/ws')
    ).resolves.toBeUndefined()

    expect(useTeamModeStore.getState().teamGitFileSyncStatusMap).toEqual({ 'x.md': 'modified' })
  })

  it('clearTeamMode resets teamGitFileSyncStatusMap', async () => {
    const { useTeamModeStore } = await import('@/stores/team-mode')
    useTeamModeStore.setState({ teamGitFileSyncStatusMap: { 'x.md': 'modified' } })
    await useTeamModeStore.getState().clearTeamMode()
    expect(useTeamModeStore.getState().teamGitFileSyncStatusMap).toEqual({})
  })
})
