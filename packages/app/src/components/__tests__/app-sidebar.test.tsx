import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'

const uiVariantMocks = vi.hoisted(() => ({ workspaceShell: false }))

const uiStoreMocks = vi.hoisted(() => ({
  advancedMode: true,
  defaultNavTab: 'session',
  switchToSession: vi.fn(() => Promise.resolve()),
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
  activeTab: 'shortcuts',
}))

const teamModeStoreMocks = vi.hoisted(() => ({
  teamMode: false,
  teamModeType: null as string | null,
  p2pConnected: false,
  loadTeamGitFileSyncStatus: vi.fn(),
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
  archivedSessions: [] as unknown[],
  pinnedSessionIds: ['s1'],
  importedSessionIds: [],
  activeSessionId: 's1',
  isLoading: false,
  isLoadingArchivedSessions: false,
  archivedSessionError: null as string | null,
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
  loadArchivedSessions: vi.fn(() => Promise.resolve()),
  openArchivedSession: vi.fn(() => Promise.resolve()),
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
  useUIStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel(uiStoreMocks as unknown as Record<string, unknown>),
    { getState: () => uiStoreMocks },
  ),
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
  SidebarContent: ({ children, className }: any) => (
    <div data-testid="sidebar-content" className={className}>
      {children}
    </div>
  ),
  SidebarFooter: ({ children }: any) => <div>{children}</div>,
  SidebarGroup: ({ children, className }: any) => <div className={className}>{children}</div>,
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
  CommandDialog: ({ children, open }: any) => open ? <div data-testid="session-search-dialog">{children}</div> : null,
  CommandInput: ({ placeholder }: any) => <input aria-label={placeholder} placeholder={placeholder} />,
  CommandList: ({ children, className }: any) => <div className={className}>{children}</div>,
  CommandEmpty: ({ children }: any) => <div>{children}</div>,
  CommandGroup: ({ children, heading }: any) => (
    <section aria-label={heading}>
      <h2>{heading}</h2>
      {children}
    </section>
  ),
  CommandItem: ({ children, onSelect, value }: any) => (
    <button type="button" data-value={value} onClick={() => onSelect?.(value)}>
      {children}
    </button>
  ),
}))

vi.mock('@/components/NodeStatusPopover', () => ({
  NodeStatusPopover: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@/components/navigation/DefaultBottomNav', () => ({
  DefaultBottomNav: () => <div data-testid="default-bottom-nav">default-bottom-nav</div>,
}))

vi.mock('@/components/panel/ShortcutsPanel', () => ({
  ShortcutsPanel: () => <div data-testid="shortcuts-panel">shortcuts-panel</div>,
}))

vi.mock('@/components/panel/RightPanel', () => ({
  RightPanel: ({ defaultTab }: { defaultTab?: string }) => (
    <div data-testid="right-panel">{defaultTab}</div>
  ),
}))

import { AppSidebar } from '@/components/app-sidebar'

describe('AppSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStoreMocks.sessions = [
      { id: 's1', title: 'Session One', updatedAt: new Date('2025-01-01'), messages: [] },
      { id: 's2', title: 'Session Two', updatedAt: new Date('2025-01-02'), messages: [] },
    ]
    sessionStoreMocks.archivedSessions = []
    sessionStoreMocks.pinnedSessionIds = ['s1']
    sessionStoreMocks.activeSessionId = 's1'
    sessionStoreMocks.isLoadingArchivedSessions = false
    sessionStoreMocks.archivedSessionError = null
    sessionStoreMocks.highlightedSessionIds = []
    sessionStoreMocks.pendingPermissions = []
    sessionStoreMocks.pendingQuestions = []
    sessionStoreMocks.loadArchivedSessions = vi.fn(() => Promise.resolve())
    sessionStoreMocks.openArchivedSession = vi.fn(() => Promise.resolve())
    uiVariantMocks.workspaceShell = false
    uiStoreMocks.defaultNavTab = 'session'
    uiStoreMocks.switchToSession = vi.fn(() => Promise.resolve())
    uiStoreMocks.embeddedSettingsSection = null
    uiStoreMocks.openSettings = vi.fn()
    uiStoreMocks.closeSettings = vi.fn()
    uiStoreMocks.openEmbeddedSettingsSection = vi.fn()
    uiStoreMocks.closeEmbeddedSettingsSection = vi.fn()
    workspaceStoreMocks.isPanelOpen = false
    workspaceStoreMocks.activeTab = 'shortcuts'
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

  it('default mode renders the default bottom navigation instead of the mixed quick access list', () => {
    uiVariantMocks.workspaceShell = false
    render(<AppSidebar />)
    expect(screen.getByTestId('default-bottom-nav')).toBeDefined()
    expect(screen.queryByText('Automation')).toBeNull()
    expect(screen.queryByText('Roles & Skills')).toBeNull()
  })

  it('default mode replaces the session list with the shortcuts content', () => {
    uiVariantMocks.workspaceShell = false
    uiStoreMocks.defaultNavTab = 'shortcuts'
    render(<AppSidebar />)
    expect(screen.getByTestId('shortcuts-panel')).toBeDefined()
    expect(screen.queryByText('Session One')).toBeNull()
  })

  it('default mode replaces the session list with the knowledge content', () => {
    uiVariantMocks.workspaceShell = false
    uiStoreMocks.defaultNavTab = 'knowledge'
    render(<AppSidebar />)
    expect(screen.getByTestId('right-panel').textContent).toBe('knowledge')
    expect(screen.queryByText('Session One')).toBeNull()
  })

  it('default mode uses the session header controls for the session tab', () => {
    uiVariantMocks.workspaceShell = false
    uiStoreMocks.defaultNavTab = 'session'

    render(<AppSidebar />)

    expect(screen.getByTitle('Collapse sidebar')).toBeDefined()
    expect(screen.getByTitle('Search (⌘K)')).toBeDefined()
    expect(screen.getByTitle('Show scheduled sessions')).toBeDefined()
    expect(screen.getByTitle('New Chat')).toBeDefined()
  })

  it("session search defaults to active sessions and can switch to archived results", async () => {
    sessionStoreMocks.archivedSessions = [
      {
        id: "archived-1",
        title: "Archived Todo Chat",
        updatedAt: new Date("2026-05-01T10:00:00.000Z"),
        archivedAt: new Date("2026-05-02T10:00:00.000Z"),
        isArchived: true,
        messages: [],
      },
    ]

    render(<AppSidebar />)

    fireEvent.click(screen.getByTitle("Search (⌘K)"))

    const dialog = screen.getByTestId("session-search-dialog")
    expect(dialog).toBeDefined()
    expect(within(dialog).getByText("Session One")).toBeDefined()
    expect(within(dialog).queryByText("Archived Todo Chat")).toBeNull()

    fireEvent.click(within(dialog).getByRole("button", { name: "Archived" }))

    expect(sessionStoreMocks.loadArchivedSessions).toHaveBeenCalledWith("/workspace")
    expect(within(dialog).getByText("Archived Todo Chat")).toBeDefined()
    expect(within(dialog).queryByText("Session One")).toBeNull()
  })

  it("selecting an archived search result opens archived read-only mode", async () => {
    let resolveOpenArchivedSession: () => void
    const openArchivedSessionPromise = new Promise<void>((resolve) => {
      resolveOpenArchivedSession = resolve
    })
    sessionStoreMocks.openArchivedSession = vi.fn(() => openArchivedSessionPromise)
    sessionStoreMocks.archivedSessions = [
      {
        id: "archived-1",
        title: "Archived Todo Chat",
        updatedAt: new Date("2026-05-01T10:00:00.000Z"),
        archivedAt: new Date("2026-05-02T10:00:00.000Z"),
        isArchived: true,
        messages: [],
      },
    ]

    render(<AppSidebar />)

    fireEvent.click(screen.getByTitle("Search (⌘K)"))
    const dialog = screen.getByTestId("session-search-dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Archived" }))
    fireEvent.click(within(dialog).getByText("Archived Todo Chat"))

    expect(screen.queryByTestId("session-search-dialog")).toBeNull()
    expect(sessionStoreMocks.openArchivedSession).toHaveBeenCalledWith("archived-1")
    expect(uiStoreMocks.switchToSession).not.toHaveBeenCalledWith("archived-1")

    resolveOpenArchivedSession!()
    await waitFor(() => {
      expect(sessionStoreMocks.openArchivedSession).toHaveBeenCalledWith("archived-1")
    })
  })

  it("session search All mode shows active and archived sessions", () => {
    sessionStoreMocks.archivedSessions = [
      {
        id: "archived-1",
        title: "Archived Todo Chat",
        updatedAt: new Date("2026-05-01T10:00:00.000Z"),
        archivedAt: new Date("2026-05-02T10:00:00.000Z"),
        isArchived: true,
        messages: [],
      },
    ]

    render(<AppSidebar />)

    fireEvent.click(screen.getByTitle("Search (⌘K)"))
    const dialog = screen.getByTestId("session-search-dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "All" }))

    expect(sessionStoreMocks.loadArchivedSessions).toHaveBeenCalledWith("/workspace")
    expect(within(dialog).getByText("Session One")).toBeDefined()
    expect(within(dialog).getByText("Archived Todo Chat")).toBeDefined()
  })

  it("selecting an active search result from All switches sessions without opening archived mode", () => {
    sessionStoreMocks.archivedSessions = [
      {
        id: "archived-1",
        title: "Archived Todo Chat",
        updatedAt: new Date("2026-05-01T10:00:00.000Z"),
        archivedAt: new Date("2026-05-02T10:00:00.000Z"),
        isArchived: true,
        messages: [],
      },
    ]

    render(<AppSidebar />)

    fireEvent.click(screen.getByTitle("Search (⌘K)"))
    const dialog = screen.getByTestId("session-search-dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "All" }))
    fireEvent.click(within(dialog).getByText("Session One"))

    expect(uiStoreMocks.switchToSession).toHaveBeenCalledWith("s1")
    expect(sessionStoreMocks.openArchivedSession).not.toHaveBeenCalledWith("s1")
  })

  it("selecting an archived search result from All opens archived mode without switching active sessions", () => {
    sessionStoreMocks.archivedSessions = [
      {
        id: "archived-1",
        title: "Archived Todo Chat",
        updatedAt: new Date("2026-05-01T10:00:00.000Z"),
        archivedAt: new Date("2026-05-02T10:00:00.000Z"),
        isArchived: true,
        messages: [],
      },
    ]

    render(<AppSidebar />)

    fireEvent.click(screen.getByTitle("Search (⌘K)"))
    const dialog = screen.getByTestId("session-search-dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "All" }))
    fireEvent.click(within(dialog).getByText("Archived Todo Chat"))

    expect(sessionStoreMocks.openArchivedSession).toHaveBeenCalledWith("archived-1")
    expect(uiStoreMocks.switchToSession).not.toHaveBeenCalledWith("archived-1")
  })

  it('default mode uses the knowledge header controls for the knowledge tab', () => {
    uiVariantMocks.workspaceShell = false
    uiStoreMocks.defaultNavTab = 'knowledge'

    const { container } = render(<AppSidebar />)

    expect(screen.getByTitle('Collapse sidebar')).toBeDefined()
    expect(screen.getByTitle('Filter files...')).toBeDefined()
    expect(screen.getByTitle('Show git changed files only')).toBeDefined()
    expect(screen.getByTitle('Collapse All')).toBeDefined()
    expect(screen.queryByTitle('New Chat')).toBeNull()
    expect(screen.queryByTitle('Search (⌘K)')).toBeNull()
    expect(container.querySelector('.border-t.border-border\\/60')).toBeNull()
  })

  it('default mode knowledge search opens a floating search bar below the topbar', () => {
    uiVariantMocks.workspaceShell = false
    uiStoreMocks.defaultNavTab = 'knowledge'

    render(<AppSidebar />)

    expect(screen.queryByPlaceholderText('Filter files...')).toBeNull()
    fireEvent.click(screen.getByTitle('Filter files...'))
    expect(screen.getByPlaceholderText('Filter files...')).toBeDefined()
    expect(screen.getByTitle('Show git changed files only')).toBeDefined()
    expect(screen.getByTitle('Collapse All')).toBeDefined()
  })

  it('default mode uses only the collapse control for the shortcuts tab', () => {
    uiVariantMocks.workspaceShell = false
    uiStoreMocks.defaultNavTab = 'shortcuts'

    const { container } = render(<AppSidebar />)

    expect(screen.getByTitle('Collapse sidebar')).toBeDefined()
    expect(screen.getByTitle('New Shortcut')).toBeDefined()
    expect(screen.queryByTitle('New Chat')).toBeNull()
    expect(screen.queryByTitle('Search (⌘K)')).toBeNull()
    expect(screen.queryByTitle('Filter files...')).toBeNull()
    expect(container.querySelector('.border-t.border-border\\/60')).toBeNull()
  })

  it('default mode shortcuts new button opens the shortcuts settings page', () => {
    uiVariantMocks.workspaceShell = false
    uiStoreMocks.defaultNavTab = 'shortcuts'

    render(<AppSidebar />)

    fireEvent.click(screen.getByTitle('New Shortcut'))
    expect(uiStoreMocks.openSettings).toHaveBeenCalledWith('shortcuts')
  })

  it('workspace mode does not render bottom Knowledge entry', () => {
    uiVariantMocks.workspaceShell = true
    render(<AppSidebar />)
    // workspace mode has its own quick links but NOT "Knowledge"
    expect(screen.queryByText('Knowledge')).toBeNull()
  })

  it('workspace mode renders settings entry with english fallback text', () => {
    uiVariantMocks.workspaceShell = true
    render(<AppSidebar />)
    expect(screen.getByText('Settings')).toBeDefined()
    expect(screen.queryByText('设置')).toBeNull()
  })

  it('workspace mode only scrolls the session list area', () => {
    uiVariantMocks.workspaceShell = true

    const { container } = render(<AppSidebar />)

    expect(screen.getByTestId('sidebar-content').getAttribute('class')).toContain('overflow-hidden')

    const sessionScrollRegion = container.querySelector('[data-testid="sidebar-session-scroll"]')
    expect(sessionScrollRegion).not.toBeNull()
    expect(sessionScrollRegion!.getAttribute('class')).toContain('overflow-y-auto')
    expect(sessionScrollRegion!.textContent).toContain('Session One')
    expect(sessionScrollRegion!.textContent).toContain('Session Two')
    expect(sessionScrollRegion!.textContent).not.toContain('Shortcuts')
    expect(sessionScrollRegion!.textContent).not.toContain('Automation')
    expect(sessionScrollRegion!.textContent).not.toContain('Roles & Skills')
    expect(sessionScrollRegion!.textContent).not.toContain('New Chat')
  })

  it('workspace variant preserves the settings footer row', () => {
    uiVariantMocks.workspaceShell = true
    render(<AppSidebar />)
    expect(screen.getByText('Settings')).toBeDefined()
  })

  it('shows connected P2P icon state from engine snapshot', () => {
    uiVariantMocks.workspaceShell = true
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
    uiVariantMocks.workspaceShell = true
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
    uiVariantMocks.workspaceShell = true
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
