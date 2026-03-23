import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/provider', () => ({
  useProviderStore: vi.fn((sel: (s: any) => any) => {
    const state = {
      providers: [],
      providersLoading: false,
      configuredProviders: [],
      customProviderIds: [],
      refreshProviders: vi.fn(),
      refreshConfiguredProviders: vi.fn(),
      refreshCustomProviderIds: vi.fn(),
      connectProvider: vi.fn(),
      addCustomProvider: vi.fn(),
      removeCustomProvider: vi.fn(),
      disconnectProvider: vi.fn(),
      initAll: vi.fn(),
    }
    return sel(state)
  }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => {
    const state = { workspacePath: '/test' }
    return sel(state)
  }),
}))
vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: vi.fn((sel: (s: any) => any) => {
    const state = { teamMode: false, teamModelConfig: null }
    return sel(state)
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/opencode/client', () => ({ initOpenCodeClient: vi.fn() }))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' ') }))
vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}))

import { LLMSection } from '../LLMSection'

describe('LLMSection', () => {
  it('renders the LLM Model title', () => {
    render(<LLMSection />)
    expect(screen.getByText('LLM Model')).toBeTruthy()
  })

  it('shows no providers message when empty', () => {
    render(<LLMSection />)
    expect(screen.getByText('No providers available')).toBeTruthy()
  })
})
