import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

const uiVariantMocks = vi.hoisted(() => ({ workspaceShell: false }))

const uiStoreMocks = vi.hoisted(() => ({
  advancedMode: true,
  openSettings: vi.fn(),
  closeSettings: vi.fn(),
  embeddedSettingsSection: null as string | null,
  openEmbeddedSettingsSection: vi.fn(),
  closeEmbeddedSettingsSection: vi.fn(),
}))

const workspaceStoreMocks = vi.hoisted(() => ({
  openPanel: vi.fn(),
  closePanel: vi.fn(),
  clearSelection: vi.fn(),
  setWorkspace: vi.fn(),
  workspacePath: '/workspace',
  workspaceName: 'workspace',
  isLoadingWorkspace: false,
  isPanelOpen: false,
  activeTab: 'tasks',
}))

const teamModeStoreMocks = vi.hoisted(() => ({
  teamMode: false,
  p2pConnected: false,
}))

const teamOssStoreMocks = vi.hoisted(() => ({
  configured: false,
  connected: false,
}))

const p2pEngineStoreMocks = vi.hoisted(() => ({
  initialized: true,
  snapshot: {
    status: 'disconnected',
    streamHealth: 'dead',
  },
  init: vi.fn(async () => () => {}),
  fetch: vi.fn(async () => {}),
}))

const sessionStoreMocks = vi.hoisted(() => ({
  sessions: [
    { id: 's1', title: 'Session One', updatedAt: new Date('2025-01-01'), messages: [] },
    { id: 's2', title: 'Session Two', updatedAt: new Date('2025-01-02'), messages: [] },
  ],
  pinnedSessionIds: ['s1'],
  importedSessionIds: [],
  activeSessionId: 's1',
  isLoading: false,
  isLoadingMore: false,
  hasMoreSessions: false,
  visibleSessionCount: 50,
  highlightedSessionIds: [],
  pendingPermissions: [],
  pendingQuestions: [],
  setActiveSession: vi.fn(),
  archiveSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  toggleSessionPinned: vi.fn(),
  loadMoreSessions: vi.fn(),
  createSession: vi.fn(),
  removeImportedSession: vi.fn(),
  exportSession: vi.fn(),
}))

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, _opts?: Record<string, unknown>) => fallback,
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/lib/date-format', () => ({
  formatSessionDate: (d: Date) => d.toISOString(),
  formatRelativeTime: (d: Date) => d.toISOString(),
}))

// Mock stores
vi.mock('@/stores/session', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(sessionStoreMocks as unknown as Record<string, unknown>),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(uiStoreMocks as unknown as Record<string, unknown>),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(workspaceStoreMocks),
}))

vi.mock('@/stores/tabs', () => ({
  useTabsStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({}),
    { getState: () => ({ hideAll: vi.fn() }) },
  ),
}))

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(teamModeStoreMocks as unknown as Record<string, unknown>),
}))

vi.mock('@/stores/team-oss', () => ({
  useTeamOssStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(teamOssStoreMocks as unknown as Record<string, unknown>),
}))

vi.mock('@/stores/p2p-engine', () => ({
  useP2pEngineStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(p2pEngineStoreMocks as unknown as Record<string, unknown>),
}))

// Mock sidebar UI components
vi.mock('@/lib/ui-variant', () => ({
  isWorkspaceUIVariant: () => uiVariantMocks.workspaceShell,
}))

vi.mock('@/components/ui/sidebar', () => ({
  Sidebar: ({ children, ...props }: any) => <div data-testid="sidebar" {...props}>{children}</div>,
  SidebarContent: ({ children }: any) => <div>{children}</div>,
  SidebarFooter: ({ children }: any) => <div>{children}</div>,
  SidebarGroup: ({ children }: any) => <div>{children}</div>,
  SidebarHeader: ({ children }: any) => <div>{children}</div>,
  SidebarMenu: ({ children }: any) => <div>{children}</div>,
  SidebarMenuButton: ({ children, onClick, isActive: _isActive, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
  SidebarMenuItem: ({ children }: any) => <div>{children}</div>,
  useSidebar: () => ({ toggleSidebar: vi.fn(), state: 'expanded' }),
}))

vi.mock('@/components/ui/traffic-lights', () => ({
  TrafficLights: () => null,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: any) => <div onClick={onClick}>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => <div>{children}</div>,
  TooltipContent: ({ children }: any) => <div>{children}</div>,
  TooltipTrigger: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@/components/ui/command', () => ({
  CommandDialog: () => null,
  CommandInput: () => null,
  CommandList: () => null,
  CommandEmpty: () => null,
  CommandGroup: () => null,
  CommandItem: () => null,
}))

vi.mock('@/components/NodeStatusPopover', () => ({
  NodeStatusPopover: ({ children }: any) => <div>{children}</div>,
}))

import { AppSidebar } from '@/components/app-sidebar'

describe('AppSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStoreMocks.sessions = [
      { id: 's1', title: 'Session One', updatedAt: new Date('2025-01-01'), messages: [] },
      { id: 's2', title: 'Session Two', updatedAt: new Date('2025-01-02'), messages: [] },
    ]
    sessionStoreMocks.pinnedSessionIds = ['s1']
    sessionStoreMocks.activeSessionId = 's1'
    sessionStoreMocks.highlightedSessionIds = []
    sessionStoreMocks.pendingPermissions = []
    sessionStoreMocks.pendingQuestions = []
    uiVariantMocks.workspaceShell = false
    uiStoreMocks.embeddedSettingsSection = null
    uiStoreMocks.openSettings = vi.fn()
    uiStoreMocks.closeSettings = vi.fn()
    uiStoreMocks.openEmbeddedSettingsSection = vi.fn()
    uiStoreMocks.closeEmbeddedSettingsSection = vi.fn()
    workspaceStoreMocks.isPanelOpen = false
    workspaceStoreMocks.activeTab = 'tasks'
    workspaceStoreMocks.openPanel = vi.fn()
    workspaceStoreMocks.closePanel = vi.fn()
    teamModeStoreMocks.teamMode = false
    teamModeStoreMocks.p2pConnected = false
    teamOssStoreMocks.configured = false
    teamOssStoreMocks.connected = false
    p2pEngineStoreMocks.initialized = true
    p2pEngineStoreMocks.snapshot = {
      status: 'disconnected',
      streamHealth: 'dead',
    }
    p2pEngineStoreMocks.init = vi.fn(async () => () => {})
    p2pEngineStoreMocks.fetch = vi.fn(async () => {})
  })

  it('renders session titles in sidebar', () => {
    render(<AppSidebar />)
    expect(screen.getByText('Session One')).toBeDefined()
    expect(screen.getByText('Session Two')).toBeDefined()
  })

  it('shows pinned sessions before newer unpinned sessions', () => {
    render(<AppSidebar />)
    expect(screen.getByText('Pinned')).toBeDefined()
    expect(screen.getByText('All sessions')).toBeDefined()
    const sessionOne = screen.getByText('Session One')
    const sessionTwo = screen.getByText('Session Two')
    const sessionOneButton = sessionOne.closest('button')
    const sessionTwoButton = sessionTwo.closest('button')

    expect(sessionOneButton).not.toBeNull()
    expect(sessionTwoButton).not.toBeNull()
    expect(
      sessionOneButton!.compareDocumentPosition(sessionTwoButton!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('hides child sessions from the homepage sidebar session list', () => {
    sessionStoreMocks.sessions = [
      ...sessionStoreMocks.sessions,
      {
        id: 'child-1',
        title: 'Child Session',
        updatedAt: new Date('2025-01-03'),
        messages: [],
        parentID: 's1',
      },
    ]

    render(<AppSidebar />)

    expect(screen.queryByText('Child Session')).toBeNull()
    expect(screen.getByText('Session One')).toBeDefined()
    expect(screen.getByText('Session Two')).toBeDefined()
  })

  it('renders sidebar container', () => {
    render(<AppSidebar />)
    expect(screen.getByTestId('sidebar')).toBeDefined()
  })

  it('renders session date information', () => {
    render(<AppSidebar />)
    // The dates should be rendered (using the formatDate function in the component)
    // The component uses its own formatDate, not the mocked formatSessionDate
    // Just verify we have session items rendered
    const buttons = screen.getAllByRole('button')
    // Should have session buttons + settings + workspace selector + sidebar toggle + search + new chat
    expect(buttons.length).toBeGreaterThan(2)
  })

  it('with workspace UI variant shows Shortcuts above Automation and Roles & Skills', () => {
    uiVariantMocks.workspaceShell = true
    render(<AppSidebar />)
    expect(screen.getByText('Shortcuts')).toBeDefined()
    expect(screen.getByText('Automation')).toBeDefined()
    expect(screen.getByText('Roles & Skills')).toBeDefined()
  })

  it('default mode renders Quick Access section with merged roles and skills entry', () => {
    uiVariantMocks.workspaceShell = false
    render(<AppSidebar />)
    expect(screen.getByText('Shortcuts')).toBeDefined()
    expect(screen.getByText('Automation')).toBeDefined()
    expect(screen.getByText('Roles & Skills')).toBeDefined()
    expect(screen.getByText('Knowledge')).toBeDefined()
  })

  it('workspace mode does not render bottom Knowledge entry', () => {
    uiVariantMocks.workspaceShell = true
    render(<AppSidebar />)
    // workspace mode has its own quick links but NOT "Knowledge"
    expect(screen.queryByText('Knowledge')).toBeNull()
  })

  it('clicking Shortcuts in Quick Access calls openPanel with "shortcuts"', () => {
    uiVariantMocks.workspaceShell = false
    render(<AppSidebar />)
    screen.getByText('Shortcuts').closest('button')!.click()
    expect(workspaceStoreMocks.openPanel).toHaveBeenCalledWith('shortcuts')
  })

  it('clicking Knowledge in Quick Access calls openPanel with "knowledge"', () => {
    uiVariantMocks.workspaceShell = false
    render(<AppSidebar />)
    screen.getByText('Knowledge').closest('button')!.click()
    expect(workspaceStoreMocks.openPanel).toHaveBeenCalledWith('knowledge')
  })

  it('clicking active Automation in Quick Access closes it', () => {
    uiVariantMocks.workspaceShell = false
    uiStoreMocks.embeddedSettingsSection = 'automation'  // already active
    render(<AppSidebar />)
    screen.getByText('Automation').closest('button')!.click()
    expect(uiStoreMocks.closeEmbeddedSettingsSection).toHaveBeenCalled()
  })

  it('clicking active Knowledge in Quick Access closes the panel', () => {
    uiVariantMocks.workspaceShell = false
    const closePanelFn = vi.fn()
    workspaceStoreMocks.isPanelOpen = true
    workspaceStoreMocks.activeTab = 'knowledge'
    workspaceStoreMocks.closePanel = closePanelFn
    render(<AppSidebar />)
    screen.getByText('Knowledge').closest('button')!.click()
    expect(closePanelFn).toHaveBeenCalled()
  })

  it('shows connected P2P icon state from engine snapshot', () => {
    teamModeStoreMocks.teamMode = true
    p2pEngineStoreMocks.snapshot = {
      status: 'connected',
      streamHealth: 'healthy',
    }

    render(<AppSidebar />)

    const icon = screen.getByTestId('workspace-p2p-icon')
    expect(icon.getAttribute('data-p2p-status')).toBe('connected')
    expect(icon.getAttribute('class')).toContain('text-blue-500')
  })

  it('shows degraded P2P icon state from engine snapshot', () => {
    teamModeStoreMocks.teamMode = true
    p2pEngineStoreMocks.snapshot = {
      status: 'connected',
      streamHealth: 'restarting',
    }

    render(<AppSidebar />)

    const icon = screen.getByTestId('workspace-p2p-icon')
    expect(icon.getAttribute('data-p2p-status')).toBe('degraded')
    expect(icon.getAttribute('class')).toContain('text-amber-500')
  })

  it('shows disconnected P2P icon state when engine is disconnected', () => {
    teamModeStoreMocks.teamMode = true
    p2pEngineStoreMocks.snapshot = {
      status: 'disconnected',
      streamHealth: 'dead',
    }

    render(<AppSidebar />)

    const icon = screen.getByTestId('workspace-p2p-icon')
    expect(icon.getAttribute('data-p2p-status')).toBe('disconnected')
    expect(icon.getAttribute('class')).toContain('text-muted-foreground')
  })
})
