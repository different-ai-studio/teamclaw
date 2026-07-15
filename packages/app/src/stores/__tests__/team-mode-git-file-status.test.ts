import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()
const cloud = vi.hoisted(() => ({
  loadLlmConfig: vi.fn(),
  currentTeamId: null as string | null,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('@/lib/daemon-local-client', () => ({
  encodeWorkspaceId: (path: string) => path,
  deleteDaemonProviderAuth: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/team-provider', () => ({
  TEAM_SHARED_PROVIDER_ID: 'team',
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

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({}),
  },
}))

vi.mock('@/lib/build-config', () => ({
  appShortName: 'teamclaw',
  TEAM_REPO_DIR: 'teamclaw-team',
  buildConfig: { team: { lockLlmConfig: false } },
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    teamWorkspaceConfig: { loadLlmConfig: cloud.loadLlmConfig },
  }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: cloud.currentTeamId ? { id: cloud.currentTeamId } : null }),
  },
}))

vi.mock('@/stores/team-share', () => ({
  useTeamShareStore: { getState: () => ({ status: { mode: null } }) },
}))

beforeEach(() => {
  mockInvoke.mockReset()
  cloud.loadLlmConfig.mockReset()
  cloud.loadLlmConfig.mockResolvedValue(null)
  cloud.currentTeamId = null
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

  it('applyTeamModel refreshes teamModelConfig from the cloud team LLM', async () => {
    cloud.currentTeamId = 'team-1'
    cloud.loadLlmConfig.mockResolvedValueOnce({
      enabled: true,
      baseUrl: 'https://ai.ucar.cc',
      models: [
        { id: 'default', name: 'Default' },
        { id: 'pro', name: 'Pro' },
      ],
      availableModels: [],
      aiGatewayEndpoint: null,
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

    await useTeamModeStore.getState().applyTeamModel('/ws')

    expect(cloud.loadLlmConfig).toHaveBeenCalledWith('team-1')
    expect(useTeamModeStore.getState().teamModelConfig).toEqual({
      baseUrl: 'https://ai.ucar.cc',
      model: 'default',
      modelName: 'Default',
    })
    expect(useTeamModeStore.getState().teamModelOptions).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'pro', name: 'Pro' },
    ])
  })
})
