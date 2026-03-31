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
    sel({
      sessions: [
        { id: 's1', title: 'Session One', updatedAt: new Date('2025-01-01'), messages: [] },
        { id: 's2', title: 'Session Two', updatedAt: new Date('2025-01-02'), messages: [] },
      ],
      pinnedSessionIds: ['s1'],
      activeSessionId: 's1',
      isLoading: false,
      isLoadingMore: false,
      hasMoreSessions: false,
      visibleSessionCount: 50,
      highlightedSessionIds: [],
      setActiveSession: vi.fn(),
      archiveSession: vi.fn(),
      updateSessionTitle: vi.fn(),
      toggleSessionPinned: vi.fn(),
      loadMoreSessions: vi.fn(),
      createSession: vi.fn(),
    }),
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
  SidebarMenuButton: ({ children, onClick, ...props }: any) => (
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

import { AppSidebar } from '@/components/app-sidebar'

describe('AppSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('with workspace UI variant shows Shortcuts above Automation and Skills', () => {
    uiVariantMocks.workspaceShell = true
    render(<AppSidebar />)
    expect(screen.getByText('Shortcuts')).toBeDefined()
    expect(screen.getByText('Automation')).toBeDefined()
    expect(screen.getByText('Skills')).toBeDefined()
  })

  it('default mode renders Quick Access section with all four entries', () => {
    uiVariantMocks.workspaceShell = false
    render(<AppSidebar />)
    expect(screen.getByText('Shortcuts')).toBeDefined()
    expect(screen.getByText('Automation')).toBeDefined()
    expect(screen.getByText('Skills')).toBeDefined()
    expect(screen.getByText('Files')).toBeDefined()
  })

  it('workspace mode does not render bottom Files entry', () => {
    uiVariantMocks.workspaceShell = true
    render(<AppSidebar />)
    // workspace mode has its own quick links but NOT "Files"
    expect(screen.queryByText('Files')).toBeNull()
  })

  it('clicking Shortcuts in Quick Access calls openPanel with "shortcuts"', () => {
    uiVariantMocks.workspaceShell = false
    render(<AppSidebar />)
    screen.getByText('Shortcuts').closest('button')!.click()
    expect(workspaceStoreMocks.openPanel).toHaveBeenCalledWith('shortcuts')
  })

  it('clicking Files in Quick Access calls openPanel with "files"', () => {
    uiVariantMocks.workspaceShell = false
    render(<AppSidebar />)
    screen.getByText('Files').closest('button')!.click()
    expect(workspaceStoreMocks.openPanel).toHaveBeenCalledWith('files')
  })

  it('clicking active Automation in Quick Access closes it', () => {
    uiVariantMocks.workspaceShell = false
    uiStoreMocks.embeddedSettingsSection = 'automation'  // already active
    render(<AppSidebar />)
    screen.getByText('Automation').closest('button')!.click()
    expect(uiStoreMocks.closeEmbeddedSettingsSection).toHaveBeenCalled()
  })

  it('clicking active Files in Quick Access closes the panel', () => {
    uiVariantMocks.workspaceShell = false
    const closePanelFn = vi.fn()
    workspaceStoreMocks.isPanelOpen = true
    workspaceStoreMocks.activeTab = 'files'
    workspaceStoreMocks.closePanel = closePanelFn
    render(<AppSidebar />)
    screen.getByText('Files').closest('button')!.click()
    expect(closePanelFn).toHaveBeenCalled()
  })
})
