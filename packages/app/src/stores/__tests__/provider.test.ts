import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDaemonProviders: vi.fn(),
  getDaemonProviderAuthMethods: vi.fn(),
  postDaemonProviderOAuthAuthorize: vi.fn(),
  postDaemonProviderOAuthCallback: vi.fn(),
  reloadDaemonRuntime: vi.fn(),
  workspacePath: '/workspace/demo',
  runtimeById: {} as Record<string, any>,
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/build-config', () => ({
  appShortName: 'teamclaw',
}))

vi.mock('@/lib/storage', () => ({
  workspaceScopedKey: (base: string, workspacePath?: string | null) => `${base}:${workspacePath ?? ''}`,
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({
      workspacePath: mocks.workspacePath,
    }),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const daemonMocks = vi.hoisted(() => ({
  deleteDaemonProviderAuth: vi.fn(),
}))

vi.mock('@/lib/daemon-local-client', () => ({
  encodeWorkspaceId: (path: string) => path,
  getDaemonProviders: mocks.getDaemonProviders,
  getDaemonProviderAuthMethods: mocks.getDaemonProviderAuthMethods,
  postDaemonProviderOAuthAuthorize: mocks.postDaemonProviderOAuthAuthorize,
  postDaemonProviderOAuthCallback: mocks.postDaemonProviderOAuthCallback,
  reloadDaemonRuntime: mocks.reloadDaemonRuntime,
  putDaemonProviderAuth: vi.fn(),
  deleteDaemonProviderAuth: daemonMocks.deleteDaemonProviderAuth,
}))

vi.mock('@/stores/runtime-state-store', () => ({
  useRuntimeStateStore: {
    getState: () => ({
      byRuntimeId: mocks.runtimeById,
    }),
  },
}))

vi.mock('@/lib/opencode/config', () => ({
  providerApiKeyName: vi.fn((id: string) => `PROVIDER_${id.toUpperCase()}_API_KEY`),
}))

describe('provider store initAll', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    mocks.workspacePath = '/workspace/demo'
    mocks.runtimeById = {}
    mocks.getDaemonProviders.mockReset()
    mocks.getDaemonProviderAuthMethods.mockReset()
    mocks.postDaemonProviderOAuthAuthorize.mockReset()
    mocks.postDaemonProviderOAuthCallback.mockReset()
    mocks.reloadDaemonRuntime.mockReset()
    mocks.reloadDaemonRuntime.mockResolvedValue('applied_live')
    mocks.getDaemonProviders.mockResolvedValue(null)
    mocks.getDaemonProviderAuthMethods.mockResolvedValue({
      openai: [{ type: 'oauth', label: 'Browser login' }],
    })
    daemonMocks.deleteDaemonProviderAuth.mockReset()
    daemonMocks.deleteDaemonProviderAuth.mockResolvedValue('restart_required')
  })

  it('surfaces OpenCode runtime-advertised models in model settings', async () => {
    mocks.runtimeById = {
      'runtime-1': {
        info: {
          agentType: 2,
          availableModels: [
            { id: 'openai/gpt-4o', displayName: 'GPT-4o' },
            { id: 'opencode/qwen3.6-plus-free', displayName: 'OpenCode Zen/Qwen3.6 Plus Free' },
          ],
          currentModel: 'openai/gpt-4o',
        },
      },
    }

    const { useProviderStore, getSelectedModelOption } = await import('../provider')

    await useProviderStore.getState().initAll()

    const state = useProviderStore.getState()
    expect(state.providers).toEqual(
      expect.arrayContaining([
        { id: 'openai', name: 'OpenAI', configured: true },
        { id: 'opencode', name: 'OpenCode', configured: true },
      ]),
    )
    expect(state.models).toEqual(
      expect.arrayContaining([
        { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o' },
        { provider: 'opencode', id: 'qwen3.6-plus-free', name: 'OpenCode Zen/Qwen3.6 Plus Free' },
      ]),
    )
    expect(state.currentModelKey).toBe('openai/gpt-4o')
    expect(getSelectedModelOption(state)).toMatchObject({
      provider: 'openai',
      id: 'gpt-4o',
      name: 'GPT-4o',
    })
  })

  it('loads OAuth auth methods from daemon HTTP', async () => {
    const { useProviderStore } = await import('../provider')
    await useProviderStore.getState().refreshAuthMethods()

    expect(mocks.getDaemonProviderAuthMethods).toHaveBeenCalledWith('/workspace/demo')
    expect(useProviderStore.getState().authMethods.openai).toEqual([
      { type: 'oauth', label: 'Browser login' },
    ])
  })

  it('falls back to built-in OAuth methods when daemon catalog is unavailable', async () => {
    mocks.getDaemonProviderAuthMethods.mockResolvedValue(null)

    const { useProviderStore } = await import('../provider')
    await useProviderStore.getState().refreshAuthMethods()

    expect(useProviderStore.getState().authMethods.openai).toEqual([
      { type: 'oauth', label: 'Browser login' },
    ])
  })

  it('returns pending OAuth state from daemon authorize response', async () => {
    mocks.postDaemonProviderOAuthAuthorize.mockResolvedValue({
      ok: true,
      url: 'https://auth.example.test/openai',
      method: 'code',
      instructions: 'Paste code',
    })

    const { useProviderStore } = await import('../provider')
    const result = await useProviderStore.getState().connectProviderOAuth('openai', 0)

    expect(result).toEqual({
      status: 'pending',
      url: 'https://auth.example.test/openai',
      instructions: 'Paste code',
      methodType: 'code',
    })
  })

  it('surfaces daemon error when OAuth authorize fails', async () => {
    mocks.postDaemonProviderOAuthAuthorize.mockResolvedValue({
      ok: false,
      status: 503,
      code: 'runtime_unavailable',
      message: 'opencode serve unavailable',
    })

    const { useProviderStore } = await import('../provider')
    const result = await useProviderStore.getState().connectProviderOAuth('openai', 0)

    expect(result.status).toBe('error')
    expect(result).toMatchObject({ message: 'opencode serve unavailable' })
  })

  it('reloads runtime after successful OAuth callback', async () => {
    mocks.postDaemonProviderOAuthCallback.mockResolvedValue({ ok: true })
    mocks.reloadDaemonRuntime.mockResolvedValue('reload_required')

    const { useProviderStore } = await import('../provider')
    const ok = await useProviderStore.getState().completeOAuthCallback('openai', 0, 'code-123')

    expect(ok).toBe(true)
    expect(mocks.reloadDaemonRuntime).toHaveBeenCalledWith('/workspace/demo')
  })

  it('disconnects via daemon without OpenCode sidecar', async () => {
    const { useProviderStore } = await import('../provider')
    useProviderStore.setState({
      providers: [{ id: 'openai', name: 'OpenAI', configured: true }],
      configuredProviders: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] }],
      models: [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }],
    })

    const ok = await useProviderStore.getState().disconnectProvider('openai')

    expect(ok).toBe(true)
    expect(daemonMocks.deleteDaemonProviderAuth).toHaveBeenCalledWith('/workspace/demo', 'openai')
    expect(useProviderStore.getState().providers).toEqual([
      { id: 'openai', name: 'OpenAI', configured: false },
    ])
  })

  it('keeps an explicit selected model when daemon reports a different catalog', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'opencode',
        display_name: 'OpenCode',
        authenticated: true,
        models: ['opencode/qwen3.6-plus-free', 'opencode/big-pickle'],
      },
    ])

    const { useProviderStore } = await import('../provider')
    useProviderStore.setState({
      currentModelKey: 'opencode/opencode/big-pickle',
    })

    await useProviderStore.getState().initAll()

    expect(useProviderStore.getState().currentModelKey).toBe('opencode/opencode/big-pickle')
  })

  it('shows OpenAI as a connectable provider when daemon providers are unavailable', async () => {
    localStorage.setItem('teamclaw-selected-model:/workspace/demo', 'openai/gpt-4o')

    const { useProviderStore } = await import('../provider')

    await useProviderStore.getState().initAll()

    const state = useProviderStore.getState()
    expect(state.models).toEqual([])
    expect(state.configuredProviders).toEqual([])
    expect(state.providers).toEqual([{ id: 'openai', name: 'OpenAI', configured: false }])
    expect(state.currentModelKey).toBeNull()
  })

  it('loads workspace custom models from daemon providers and restores the saved selection', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'custom-openai',
        display_name: 'Custom OpenAI',
        authenticated: true,
        models: ['my-model'],
      },
    ])
    localStorage.setItem('teamclaw-selected-model:/workspace/demo', 'custom-openai/my-model')

    const { useProviderStore, getSelectedModelOption } = await import('../provider')

    await useProviderStore.getState().initAll()

    const state = useProviderStore.getState()
    expect(state.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'custom-openai',
          id: 'my-model',
          name: 'my-model',
        }),
      ]),
    )
    expect(state.currentModelKey).toBe('custom-openai/my-model')
    expect(getSelectedModelOption(state)).toMatchObject({
      provider: 'custom-openai',
      id: 'my-model',
      name: 'my-model',
    })
  })

  it('loads daemon providers once during initAll', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'custom-openai',
        display_name: 'Custom OpenAI',
        authenticated: true,
        models: ['my-model'],
      },
    ])

    const { useProviderStore } = await import('../provider')

    await useProviderStore.getState().initAll()

    expect(mocks.getDaemonProviders).toHaveBeenCalledTimes(1)
  })

  it('falls back to a custom provider when a saved model is not in the daemon catalog', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'scnet',
        display_name: 'Scnet',
        authenticated: true,
        models: ['minimax-m2.5'],
      },
    ])
    localStorage.setItem('teamclaw-selected-model:/workspace/demo', 'opencode/opencode/qwen3.6-plus-free')

    const { useProviderStore } = await import('../provider')

    await useProviderStore.getState().initAll()

    expect(useProviderStore.getState().currentModelKey).toBe('scnet/minimax-m2.5')
  })

  it('does not recover to daemon runtime info from a custom-provider selection', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'scnet',
        display_name: 'Scnet',
        authenticated: true,
        models: ['minimax-m2.5'],
      },
    ])
    mocks.runtimeById = {
      'runtime-1': {
        info: {
          agentType: 2,
          availableModels: [
            { id: 'opencode/qwen3.6-plus-free', displayName: 'OpenCode Zen/Qwen3.6 Plus Free' },
            { id: 'opencode/big-pickle', displayName: 'Big Pickle' },
          ],
          currentModel: 'opencode/qwen3.6-plus-free',
        },
      },
    }

    const { useProviderStore } = await import('../provider')
    useProviderStore.setState({ currentModelKey: 'scnet/minimax-m2.5' })

    await useProviderStore.getState().initAll()

    expect(useProviderStore.getState().currentModelKey).toBe('scnet/minimax-m2.5')
  })

  it('filters model options to the selected backend during a session', async () => {
    const { getModelOptionsForSelectedBackend } = await import('../provider')

    const models = [
      { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
      { id: 'qwen', name: 'Qwen', provider: 'opencode' },
    ]
    const filtered = getModelOptionsForSelectedBackend({
      models,
      currentModelKey: 'openai/gpt-4o',
    })
    expect(filtered).toEqual([{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }])
  })
})
