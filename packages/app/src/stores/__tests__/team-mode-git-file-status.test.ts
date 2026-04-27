import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()
const mockLoadTeamProviderFile = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('@/lib/opencode/config', () => ({
  getCustomProviderConfig: vi.fn().mockResolvedValue(null),
  removeCustomProviderFromConfig: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/team-provider', () => ({
  TEAM_SHARED_PROVIDER_ID: 'team',
  loadTeamProviderFile: mockLoadTeamProviderFile,
}))

vi.mock('@/stores/provider', () => ({
  useProviderStore: {
    getState: () => ({
      currentModelKey: null,
      selectModel: vi.fn().mockResolvedValue(undefined),
      refreshConfiguredProviders: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))

vi.mock('@/lib/opencode/sdk-client', () => ({
  initOpenCodeClient: vi.fn(),
}))

vi.mock('@/lib/opencode/restart', () => ({
  restartOpencode: vi.fn().mockResolvedValue({ url: 'http://test' }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({
      setOpenCodeBootstrapped: vi.fn(),
      setOpenCodeReady: vi.fn(),
    }),
  },
}))

vi.mock('@/lib/build-config', () => ({
  appShortName: 'teamclaw',
  TEAM_REPO_DIR: 'teamclaw-team',
  buildConfig: { team: { llm: { models: [] }, lockLlmConfig: false } },
}))

beforeEach(() => {
  mockInvoke.mockReset()
  mockLoadTeamProviderFile.mockReset()
  mockLoadTeamProviderFile.mockResolvedValue(null)
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

  it('applies provider.json when present before falling back to legacy llm config', async () => {
    mockLoadTeamProviderFile.mockResolvedValueOnce({
      version: 1,
      provider: {
        id: 'team',
        name: 'Team',
        baseURL: 'https://ai.ucar.cc',
        apiKey: '${tc_api_key}',
        defaultModel: 'pro',
        models: [
          { id: 'default', name: 'Default' },
          { id: 'pro', name: 'Pro' },
        ],
      },
    })

    const { useTeamModeStore } = await import('@/stores/team-mode')
    useTeamModeStore.setState({
      teamModelConfig: {
        baseUrl: 'https://legacy.example.com',
        model: 'legacy',
        modelName: 'Legacy',
      },
      teamModelOptions: [],
    })

    await useTeamModeStore.getState().applyTeamModelToOpenCode('/ws')

    expect(mockLoadTeamProviderFile).toHaveBeenCalledWith('/ws')
    expect(useTeamModeStore.getState().teamModelConfig).toEqual({
      baseUrl: 'https://ai.ucar.cc',
      model: 'pro',
      modelName: 'Pro',
    })
    expect(useTeamModeStore.getState().teamModelOptions).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'pro', name: 'Pro' },
    ])
  })
})
