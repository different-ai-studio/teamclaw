import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  listDaemonWorkspaces: vi.fn(),
  getCurrentDaemonWorkspaceAgent: vi.fn(),
  isDaemonHttpAvailable: vi.fn(),
  getDaemonModelCatalog: vi.fn(),
  loadConfiguredProvidersForWorkspace: vi.fn(),
  loadLlmConfig: vi.fn(),
  isTauri: vi.fn(),
}))

vi.mock('@/lib/daemon-workspaces', () => ({
  getCurrentDaemonWorkspaceAgent: mocks.getCurrentDaemonWorkspaceAgent,
  listDaemonWorkspaces: mocks.listDaemonWorkspaces,
}))

vi.mock('@/lib/daemon-local-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/daemon-local-client')>()
  return {
    ...actual,
    isDaemonHttpAvailable: mocks.isDaemonHttpAvailable,
    getDaemonModelCatalog: mocks.getDaemonModelCatalog,
  }
})

vi.mock('@/stores/provider', () => ({
  loadConfiguredProvidersForWorkspace: mocks.loadConfiguredProvidersForWorkspace,
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    teamWorkspaceConfig: { loadLlmConfig: mocks.loadLlmConfig },
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: mocks.isTauri,
}))

import {
  resolveDaemonWorkspacePath,
  loadCronDialogModels,
} from '@/lib/cron-workspace-models'

describe('resolveDaemonWorkspacePath', () => {
  beforeEach(() => {
    mocks.listDaemonWorkspaces.mockReset()
  })

  it('returns canonical daemon path when local path matches by suffix', async () => {
    mocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-1',
        path: '/Users/me/projects/MyApp',
        teamId: 't1',
        agentId: null,
        createdByMemberId: null,
        name: 'MyApp',
        archived: false,
        createdAt: '',
        updatedAt: '',
      },
    ])

    const resolved = await resolveDaemonWorkspacePath(
      'team-1',
      '~/projects/MyApp',
    )
    expect(resolved).toBe('/Users/me/projects/MyApp')
  })
})

describe('loadCronDialogModels', () => {
  beforeEach(() => {
    mocks.getCurrentDaemonWorkspaceAgent.mockReset()
    mocks.listDaemonWorkspaces.mockReset()
    mocks.isDaemonHttpAvailable.mockReset()
    mocks.getDaemonModelCatalog.mockReset()
    mocks.loadLlmConfig.mockReset()
    mocks.loadLlmConfig.mockResolvedValue(null)
    mocks.isTauri.mockReturnValue(true)
    mocks.isDaemonHttpAvailable.mockResolvedValue(true)
  })

  const messages = {
    workspaceNoPath: 'no path',
    globalNoTeam: 'no team',
    globalNoDefault: 'no default',
    globalNoDefaultPath: 'no default path',
    daemonUnavailable: 'daemon down',
    noConfiguredModels: 'no models',
    loadFailed: 'load failed',
  }

  it('falls back to cloud daemon default when local registry has no default flag', async () => {
    mocks.getCurrentDaemonWorkspaceAgent.mockResolvedValue({
      id: 'agent-1',
      defaultWorkspaceId: 'cloud-ws-2',
    })
    mocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'cloud-ws-2',
        path: '/Users/me/copilot-ws-v2',
        archived: false,
      },
    ])
    mocks.getDaemonModelCatalog.mockResolvedValue({
      automation_default_backend: 'opencode',
      backends: [
        {
          backend: 'opencode',
          label: 'OpenCode',
          models: [
            {
              ref: 'scnet/MiniMax-M2.5',
              model_id: 'MiniMax-M2.5',
              display_name: 'MiniMax-M2.5',
            },
          ],
        },
      ],
    })

    const result = await loadCronDialogModels({
      activeScope: 'global',
      teamId: 'team-1',
      selectedWorkspacePath: null,
      localWorkspaces: [
        {
          workspaceId: 'local-1',
          remoteWorkspaceId: 'cloud-ws-2',
          path: '/Users/me/copilot-ws-v2',
          displayName: 'copilot-ws-v2',
          teamId: 'team-1',
          isDefault: false,
        },
      ],
      messages,
    })

    expect(result.hint).toBeNull()
    expect(result.automationDefaultBackend).toBe('opencode')
    expect(result.groups[0].backend).toBe('opencode')
    expect(result.groups[0].models[0].ref).toBe('scnet/MiniMax-M2.5')
    expect(mocks.getDaemonModelCatalog).toHaveBeenCalled()
  })

  it('groups Claude and Codex backends and prepends team-shared models', async () => {
    // teamId is set, so resolveDaemonWorkspacePath consults the daemon registry.
    mocks.listDaemonWorkspaces.mockResolvedValue([])
    mocks.loadLlmConfig.mockResolvedValue({
      enabled: true,
      baseUrl: 'https://llm.example',
      models: [{ id: 'shared-1', name: 'Shared 1' }],
      availableModels: [],
      aiGatewayEndpoint: null,
    })
    mocks.getDaemonModelCatalog.mockResolvedValue({
      automation_default_backend: 'claude',
      backends: [
        {
          backend: 'claude',
          label: 'Claude Code',
          models: [
            {
              ref: 'claude-code/claude-sonnet-4-6',
              model_id: 'claude-sonnet-4-6',
              display_name: 'Claude Sonnet 4.6',
            },
          ],
        },
        // Empty backend groups are dropped so the picker stays tidy.
        { backend: 'codex', label: 'Codex', models: [] },
      ],
    })

    const result = await loadCronDialogModels({
      activeScope: 'workspace',
      teamId: 'team-1',
      selectedWorkspacePath: '/ws',
      messages,
    })

    expect(mocks.loadLlmConfig).toHaveBeenCalledWith('team-1')
    expect(result.hint).toBeNull()
    expect(result.automationDefaultBackend).toBe('claude')
    // team-shared first, pinned to the opencode backend; codex dropped (empty).
    expect(result.groups.map((g) => g.label)).toEqual(['Team Shared', 'Claude Code'])
    expect(result.groups[0].backend).toBe('opencode')
    expect(result.groups[0].models[0].ref).toBe('team/shared-1')
    expect(result.groups[1].backend).toBe('claude')
  })

  it('reports daemon unavailable when HTTP probe never succeeds', async () => {
    vi.useFakeTimers()
    mocks.isDaemonHttpAvailable.mockResolvedValue(false)

    const promise = loadCronDialogModels({
      activeScope: 'global',
      teamId: null,
      selectedWorkspacePath: null,
      localWorkspaces: [
        {
          workspaceId: 'local-1',
          remoteWorkspaceId: 'r1',
          path: '/Users/me/copilot-ws-v2',
          displayName: 'copilot-ws-v2',
          teamId: null,
          isDefault: true,
        },
      ],
      messages,
    })

    await vi.advanceTimersByTimeAsync(9000)
    const result = await promise
    vi.useRealTimers()

    expect(result.groups).toEqual([])
    expect(result.hint).toBe('daemon down')
  })
})
