import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/mcp', () => ({
  useMCPStore: vi.fn((sel: (s: any) => any) => {
    const state = {
      servers: {},
      runtimeStatus: {},
      serverTools: {},
      isLoading: false,
      error: null,
      hasChanges: false,
      loadConfig: vi.fn(),
      loadRuntimeStatus: vi.fn(),
      loadTools: vi.fn(),
      addServer: vi.fn(),
      updateServer: vi.fn(),
      removeServer: vi.fn(),
      toggleServer: vi.fn(),
      setHasChanges: vi.fn(),
      clearError: vi.fn(),
    }
    return sel(state)
  }),
}))
vi.mock('@/stores/deps', () => ({
  useDepsStore: vi.fn((sel: (s: any) => any) => {
    const state = { isInstalled: () => true }
    return sel(state)
  }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => {
    const state = { workspacePath: '/test' }
    return sel(state)
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/opencode/client', () => ({ initOpenCodeClient: vi.fn() }))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' ') }))
vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
  ToggleSwitch: ({ enabled }: { enabled: boolean }) => <input type="checkbox" checked={enabled} readOnly />,
}))
vi.mock('../AddMCPDialog', () => ({ AddMCPDialog: () => null }))

import { MCPSection } from '../MCPSection'

describe('MCPSection', () => {
  it('renders the MCP Servers title', () => {
    render(<MCPSection />)
    expect(screen.getByText('MCP Servers')).toBeTruthy()
  })

  it('shows no servers message when empty', () => {
    render(<MCPSection />)
    expect(screen.getByText('No MCP servers configured')).toBeTruthy()
  })
})
