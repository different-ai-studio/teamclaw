import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const h = vi.hoisted(() => ({
  state: {
    servers: {},
    runtimeStatus: {},
    serverTools: {},
    serverProbe: {},
    toolsLoading: false,
    isLoading: false,
    error: null,
    loadConfig: vi.fn(),
    loadRuntimeStatus: vi.fn(),
    loadTools: vi.fn(),
    addServer: vi.fn(),
    updateServer: vi.fn(),
    removeServer: vi.fn(),
    toggleServer: vi.fn(),
    clearError: vi.fn(),
  } as any,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}))
vi.mock('@/stores/mcp', () => ({
  useMCPStore: vi.fn((sel: (s: any) => any) => sel(h.state)),
}))
vi.mock('@/stores/deps', () => ({
  useDepsStore: vi.fn((sel: (s: any) => any) => {
    const state = { isInstalled: () => true }
    return sel(state)
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' ') }))
vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
  ToggleSwitch: ({ enabled }: { enabled: boolean }) => <input type="checkbox" checked={enabled} readOnly />,
}))
vi.mock('../AddMCPDialog', () => ({ AddMCPDialog: () => null }))

import { MCPSection } from '../MCPSection'

describe('MCPSection', () => {
  beforeEach(() => {
    h.state = {
      servers: {},
      runtimeStatus: {},
      serverTools: {},
      serverProbe: {},
      toolsLoading: false,
      isLoading: false,
      error: null,
      loadConfig: vi.fn(),
      loadRuntimeStatus: vi.fn(),
      loadTools: vi.fn(),
      addServer: vi.fn(),
      updateServer: vi.fn(),
      removeServer: vi.fn(),
      toggleServer: vi.fn(),
      clearError: vi.fn(),
    }
  })

  it('renders the MCP Servers title', () => {
    render(<MCPSection />)
    expect(screen.getByText('MCP Servers')).toBeTruthy()
  })

  it('shows no servers message when empty', () => {
    render(<MCPSection />)
    expect(screen.getByText('No MCP servers configured')).toBeTruthy()
  })

  it('shows tools enabled summary from probe status', () => {
    h.state = {
      ...h.state,
      servers: {
        playwright: { type: 'local', enabled: true, command: ['npx', '-y', '@playwright/mcp'], source: 'inherent' },
      },
      serverTools: {
        playwright: ['browser_click', 'browser_navigate'],
      },
      serverProbe: {
        playwright: { status: 'ready' },
      },
    }
    render(<MCPSection />)
    expect(screen.getByText('settings.mcp.toolsEnabled')).toBeTruthy()
  })

  it('renders team shared MCP section from source', () => {
    h.state = {
      ...h.state,
      servers: {
        'team-db': {
          type: 'local',
          enabled: true,
          command: ['npx', '-y', 'team-db-mcp'],
          source: 'team',
        },
      },
    }
    render(<MCPSection />)
    expect(screen.getByText('settings.mcp.teamMCP')).toBeTruthy()
    expect(screen.getByText('team-db')).toBeTruthy()
  })
})
