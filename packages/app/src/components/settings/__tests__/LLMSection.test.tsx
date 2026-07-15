import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => {
  const providerState = {
    providers: [] as Array<{ id: string; name: string; configured: boolean }>,
    providersLoading: false,
    configuredProviders: [] as Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>,
    customProviderIds: [] as string[],
    authMethods: {} as Record<string, Array<{ type: 'oauth' | 'api'; label: string }>>,
    refreshAuthMethods: vi.fn(),
    refreshProviders: vi.fn(),
    refreshConfiguredProviders: vi.fn(),
    refreshCustomProviderIds: vi.fn(),
    connectProvider: vi.fn(),
    connectProviderOAuth: vi.fn(),
    completeOAuthCallback: vi.fn(),
    addCustomProvider: vi.fn(),
    updateCustomProvider: vi.fn(),
    getCustomProvider: vi.fn(),
    removeCustomProvider: vi.fn(),
    disconnectProvider: vi.fn(),
    initAll: vi.fn(),
  }
  const workspaceState = {
    workspacePath: '/test',
    openCodeReady: true,
    daemonHttpReady: true,
    setOpenCodeBootstrapped: vi.fn(),
    setWorkspace: vi.fn(),
  }
  const teamModeState = { teamModeType: null as string | null, teamModelConfig: null as null | { model: string; modelName: string; baseUrl: string }, devUnlocked: false, teamModelOptions: [] as Array<{ id: string; name: string }>, switchTeamModel: vi.fn() }
  return {
    providerState,
    workspaceState,
    teamModeState,
    shellOpen: vi.fn(),
    dialogOpen: vi.fn(),
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: string | { defaultValue?: string }) =>
      typeof d === 'string' ? d : d?.defaultValue ?? k,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}))
vi.mock('@/stores/provider', () => ({
  useProviderStore: vi.fn((sel: (s: any) => any) => {
    return sel(mocks.providerState)
  }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => {
    return sel(mocks.workspaceState)
  }),
}))
vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: vi.fn((sel: (s: any) => any) => {
    return sel(mocks.teamModeState)
  }),
}))
vi.mock('@/lib/team-permissions', () => ({
  useTeamPermissions: () => ({ role: 'owner', isOwner: true, canManageTeam: true, canEditFiles: true }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: mocks.shellOpen }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.dialogOpen }))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' '), isTauri: () => false }))
vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}))

import { LLMSection } from '../LLMSection'

describe('LLMSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
    mocks.providerState.providers = []
    mocks.providerState.providersLoading = false
    mocks.providerState.configuredProviders = []
    mocks.providerState.customProviderIds = []
    mocks.providerState.authMethods = {}
    mocks.workspaceState.workspacePath = '/test'
    mocks.workspaceState.openCodeReady = true
    mocks.workspaceState.daemonHttpReady = true
    mocks.workspaceState.setWorkspace.mockReset()
    mocks.teamModeState.teamModeType = null
    mocks.teamModeState.teamModelConfig = null
    mocks.teamModeState.devUnlocked = false
    mocks.teamModeState.teamModelOptions = []
  })

  it('renders the LLM Model title', () => {
    render(<LLMSection />)
    expect(screen.getByText('LLM Model')).toBeTruthy()
  })

  it('shows the current workspace path', () => {
    render(<LLMSection />)
    expect(screen.getByText('Workspace Path')).toBeTruthy()
    expect(screen.getByText('/test')).toBeTruthy()
  })

  it('switches workspace from the workspace path card', async () => {
    mocks.dialogOpen.mockResolvedValueOnce('/next-workspace')

    render(<LLMSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch Workspace' }))

    await waitFor(() => {
      expect(mocks.workspaceState.setWorkspace).toHaveBeenCalledWith('/next-workspace')
    })
  })

  it('refreshes provider data from the daemon workspace-control plane on mount', async () => {
    render(<LLMSection />)

    await waitFor(() => {
      expect(mocks.providerState.refreshProviders).toHaveBeenCalled()
      expect(mocks.providerState.refreshConfiguredProviders).toHaveBeenCalled()
      expect(mocks.providerState.refreshAuthMethods).toHaveBeenCalled()
    })
  })

  it('shows no providers message when empty', () => {
    render(<LLMSection />)
    expect(screen.getByText('No providers available')).toBeTruthy()
  })

  it('waits for an authorization code before completing code-based OAuth providers', async () => {
    mocks.providerState.providers = [{ id: 'openai', name: 'OpenAI', configured: false }]
    mocks.providerState.authMethods = {
      openai: [{ type: 'oauth', label: 'Browser login' }],
    }
    mocks.providerState.connectProviderOAuth.mockResolvedValueOnce({
      status: 'pending',
      url: 'https://auth.example.test/openai',
      instructions: 'Paste the authorization code from the browser.',
      methodType: 'code',
    })
    mocks.providerState.completeOAuthCallback.mockResolvedValueOnce(true)

    render(<LLMSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Login with browser' }))

    await waitFor(() => {
      expect(mocks.shellOpen).toHaveBeenCalledWith('https://auth.example.test/openai')
    })
    expect(mocks.providerState.completeOAuthCallback).not.toHaveBeenCalled()

    const codeInput = await screen.findByPlaceholderText('Paste authorization code')
    fireEvent.change(codeInput, { target: { value: 'oa-code-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Complete authorization' }))

    await waitFor(() => {
      expect(mocks.providerState.completeOAuthCallback).toHaveBeenCalledWith('openai', 0, 'oa-code-123')
    })
  })

  it('validates an OpenAI-compatible custom provider and fills returned models', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gpt-4o' },
          { id: 'gpt-4.1', name: 'GPT-4.1' },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<LLMSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Add Custom' }))
    fireEvent.change(screen.getByPlaceholderText('e.g. My OpenAI Proxy'), {
      target: { value: 'OpenAI' },
    })
    fireEvent.change(screen.getByPlaceholderText('e.g. https://api.openai.com/v1'), {
      target: { value: 'https://api.openai.com/v1/' },
    })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), {
      target: { value: 'sk-test' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Validate & fetch models' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test',
          }),
        }),
      )
    })

    await waitFor(() => {
      expect(screen.getByDisplayValue('gpt-4o')).toBeTruthy()
      expect(screen.getByDisplayValue('gpt-4.1')).toBeTruthy()
    })
  })
})
