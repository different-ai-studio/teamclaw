import * as React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionListColumn } from '../SessionListColumn'
import { useUIStore } from '@/stores/ui'
import { useSessionListStore } from '@/stores/session-list-store'
import { useSessionStore } from '@/stores/session'
import { useCronStore } from '@/stores/cron'
import { useWorkspaceStore } from '@/stores/workspace'

vi.mock('@/components/sidebar/session-search-dialog', () => ({
  SessionSearchDialog: () => null,
}))

// Sidebar UI primitives call useSidebar() which requires a SidebarProvider.
// In tests we render the column standalone, so stub these as plain wrappers
// and stub useSidebar to return an expanded sidebar by default.
vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <li className={['group/menu-item relative list-none', className].filter(Boolean).join(' ')}>{children}</li>
  ),
  SidebarMenuButton: ({ children, isActive: _isActive, ...rest }: React.ComponentProps<'button'> & { isActive?: boolean }) => (
    <button {...rest}>{children}</button>
  ),
  useSidebar: () => ({ state: 'expanded', open: true, setOpen: () => {}, toggleSidebar: () => {} }),
  useSidebarSafe: () => ({ state: 'expanded', open: true, setOpen: () => {}, toggleSidebar: () => {}, openMobile: false, setOpenMobile: () => {}, isMobile: false }),
}))

vi.mock('@/components/app-sidebar', () => ({
  SidebarCollapseToggle: () => null,
}))

vi.mock('@/components/ui/traffic-lights', () => ({
  TrafficLights: () => null,
}))

vi.mock('@/hooks/use-session-workspace-labels', () => ({
  useSessionWorkspaceLabels: () => new Map([['s1', 'copilot-ws-v3']]),
}))

const createQuickSession = vi.fn()
vi.mock('@/lib/create-quick-session', () => ({
  createQuickSession: (...args: unknown[]) => createQuickSession(...args),
  describeQuickSessionFailure: () => ({ title: 'fail', description: 'desc' }),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}))

const currentTeamState = {
  team: { id: 'team-1' },
  currentMember: { id: 'member-1' },
}

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: Object.assign(
    (selector: (s: typeof currentTeamState) => unknown) => selector(currentTeamState),
    { getState: () => currentTeamState },
  ),
}))

const mkSessionRow = (over: Partial<{
  id: string
  title: string
  idea_id: string | null
  has_unread: boolean
  last_message_at: string | null
}>) => ({
  id: 's1',
  title: 't',
  team_id: 'team-1',
  last_message_at: '2026-05-16T08:00:00.000Z',
  last_message_preview: null,
  mode: 'collab' as const,
  idea_id: null as string | null,
  has_unread: false,
  ...over,
})

const mkRow = (over: Partial<{ id: string; title: string; ideaId: string | null; lastMessageAt: string | null }> = {}) => ({
  id: over.id ?? 's1',
  title: over.title ?? 't',
  team_id: 'team-1',
  mode: 'collab' as const,
  idea_id: over.ideaId ?? null,
  last_message_at: over.lastMessageAt ?? '2026-05-17T08:00:00.000Z',
  last_message_preview: null,
  has_unread: false,
  created_at: '2026-05-17T07:59:00.000Z',
  updated_at: '2026-05-17T08:00:00.000Z',
})

describe('SessionListColumn', () => {
  beforeEach(() => {
    localStorage.setItem('teamclaw-pinned-sessions', JSON.stringify({ 'team-1': ['s1'] }))
    useUIStore.setState({ sidebarFilter: { kind: 'all' }, embedMode: false })
    createQuickSession.mockReset()
    createQuickSession.mockResolvedValue({ ok: true, sessionId: 'sess-new', agentDisplayName: 'MACPRO' })
    useSessionListStore.setState({
      rows: [
        mkRow({ id: 's1', title: 'Alpha', ideaId: null }),
        mkRow({ id: 's2', title: 'Beta', ideaId: 'idea-1' }),
        mkRow({ id: 's3', title: 'Gamma', ideaId: 'idea-1' }),
      ],
      pinnedSessionIds: ['s1'],
      highlightedSessionIds: [],
      hasMore: false,
      loading: false,
    })
    useSessionStore.setState({
      sessions: [],
      pinnedSessionIds: ['s1'],
      activeSessionId: null,
    } as any)
    useCronStore.setState({
      cronSessionIds: new Set<string>(),
      showCronSessions: false,
    })
    useSessionListStore.setState({
      rows: [
        mkSessionRow({ id: 's1', title: 'Alpha', idea_id: null, has_unread: true }),
        mkSessionRow({ id: 's2', title: 'Beta', idea_id: 'idea-1' }),
        mkSessionRow({ id: 's3', title: 'Gamma', idea_id: 'idea-1' }),
      ],
      loading: false,
      error: null,
      hasMore: false,
      nextCursor: null,
    })
  })

  it('shows all non-cron sessions in "all" mode', () => {
    render(<SessionListColumn />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  it('keeps cron sessions out of the regular Sessions view', () => {
    useCronStore.setState({ cronSessionIds: new Set(['s2']), showCronSessions: false })

    render(<SessionListColumn />)

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
    expect(screen.getByText(/Sessions|会话/)).toHaveTextContent('· 2')
  })

  it('shows only cron sessions when the clock view is active', () => {
    useCronStore.setState({ cronSessionIds: new Set(['s2']), showCronSessions: true })

    render(<SessionListColumn />)

    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument()
    expect(screen.getByText(/Scheduled sessions|定时会话/)).toHaveTextContent('· 1')
  })

  it('does not let the clock view leak into the Pinned filter', () => {
    useSessionListStore.setState({
      rows: [
        mkSessionRow({ id: 's1', title: 'Pinned regular' }),
        mkSessionRow({ id: 's2', title: 'Pinned cron' }),
      ],
      pinnedSessionIds: ['s1', 's2'],
      loading: false,
    })
    useUIStore.setState({ sidebarFilter: { kind: 'pinned' } })
    useCronStore.setState({ cronSessionIds: new Set(['s2']), showCronSessions: true })

    render(<SessionListColumn />)

    expect(screen.getByText('Pinned regular')).toBeInTheDocument()
    expect(screen.queryByText('Pinned cron')).not.toBeInTheDocument()
  })

  it('shows a quiet unread indicator for unread inactive sessions', () => {
    render(<SessionListColumn />)
    expect(screen.getByLabelText('未读')).toBeInTheDocument()
  })

  it('shows pinned sessions above regular sessions with a divider in "all" mode', () => {
    useSessionListStore.setState({
      rows: [
        mkSessionRow({ id: 's1', title: 'Pinned old', last_message_at: '2026-05-15T08:00:00.000Z' }),
        mkSessionRow({ id: 's2', title: 'Recent', last_message_at: '2026-05-17T08:00:00.000Z' }),
      ],
      pinnedSessionIds: ['s1'],
      loading: false,
    })
    render(<SessionListColumn />)

    expect(screen.getByTestId('v2-session-pinned-header')).toHaveTextContent(/Pinned|已置顶/)
    expect(screen.getByTestId('v2-session-pinned-divider')).toBeInTheDocument()

    const titles = screen.getAllByTestId('v2-session-row-title').map((el) => el.textContent)
    expect(titles[0]).toBe('Pinned old')
    expect(titles[1]).toBe('Recent')
    expect(screen.queryByText(/Today|今天/)).not.toBeInTheDocument()
  })

  it('filters to pinned sessions in "pinned" mode', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'pinned' } })
    render(<SessionListColumn />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()
  })

  it('filters by ideaId in "idea" mode', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'idea', ideaId: 'idea-1', title: 'I' } })
    render(<SessionListColumn />)
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  it('shows cron filter button only in "all" mode', () => {
    const { rerender } = render(<SessionListColumn />)
    expect(screen.getByRole('button', { name: /显示定时会话|显示全部会话/ })).toBeInTheDocument()
    useUIStore.setState({ sidebarFilter: { kind: 'pinned' } })
    rerender(<SessionListColumn />)
    expect(screen.queryByRole('button', { name: /显示定时会话|显示全部会话/ })).not.toBeInTheDocument()
  })

  it('shows workspace subline under session title in non-workspace filters', () => {
    render(<SessionListColumn />)
    expect(screen.getByTestId('v2-session-row-workspace')).toHaveTextContent('copilot-ws-v3')
  })

  it('windows the list (virtualizes) when there are many sessions', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      mkSessionRow({
        id: `s${i}`,
        title: `Session ${i}`,
        idea_id: null,
        // distinct timestamps so ordering is stable
        last_message_at: `2026-05-17T08:${String(i % 60).padStart(2, '0')}:00.000Z`,
      }),
    )
    useSessionListStore.setState({ rows: many, pinnedSessionIds: [], loading: false })
    const { container } = render(<SessionListColumn />)

    // The virtualized container is mounted instead of the plain list.
    expect(screen.getByTestId('v2-session-list-virtual')).toBeInTheDocument()
    // Windowing: the full set of 60 rows is never mounted at once. (jsdom has
    // no layout, so the virtualizer reports a 0-height viewport and mounts only
    // its overscan window — the point is that it is far fewer than 60.)
    expect(screen.queryAllByTestId('v2-session-row').length).toBeLessThan(60)
    // Virtual rows render <li> outside <SidebarMenu>; suppress default bullets.
    for (const li of container.querySelectorAll('[data-testid="v2-session-list-virtual"] li')) {
      expect(li).toHaveClass('list-none')
    }
  })

  it('hides workspace subline when filtering by workspace', () => {
    useUIStore.setState({
      sidebarFilter: { kind: 'workspace', workspaceId: 'ws1', path: '/p', name: 'copilot-ws-v3' },
    })
    render(<SessionListColumn />)
    expect(screen.queryByTestId('v2-session-row-workspace')).not.toBeInTheDocument()
  })

  it('renders an inline close button when onDismiss is provided', () => {
    const onDismiss = vi.fn()
    render(<SessionListColumn onDismiss={onDismiss} />)

    const close = screen.getByRole('button', { name: /关闭|Close/ })
    close.click()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('creates a session directly from the new chat button in embed mode', async () => {
    useUIStore.setState({ embedMode: true })
    const onDismiss = vi.fn()
    render(<SessionListColumn onDismiss={onDismiss} />)

    const newChat = screen.getByRole('button', { name: /New Chat|新聊天/ })
    newChat.click()

    await vi.waitFor(() => {
      expect(createQuickSession).toHaveBeenCalledTimes(1)
      expect(onDismiss).toHaveBeenCalledTimes(1)
    })
  })

  it('enables search and cron buttons in embed mode without a local workspace', () => {
    useUIStore.setState({ embedMode: true })
    useWorkspaceStore.setState({ workspacePath: null })
    render(<SessionListColumn onDismiss={() => {}} />)

    expect(screen.getByRole('button', { name: /Search|搜索/ })).not.toBeDisabled()
    expect(
      screen.getByRole('button', { name: /Show scheduled sessions|Show all sessions|定时/ }),
    ).not.toBeDisabled()
  })

  it('enters batch select mode and archives selected sessions', async () => {
    const archiveSession = vi.fn(async (id: string) => {
      const rows = useSessionListStore.getState().rows.filter((r) => r.id !== id)
      useSessionListStore.setState({ rows })
    })
    useUIStore.setState({ embedMode: true })
    useWorkspaceStore.setState({ workspacePath: '/tmp/ws' })
    useSessionListStore.setState({
      rows: [
        mkSessionRow({ id: 's1', title: 'Alpha', idea_id: null }),
        mkSessionRow({ id: 's2', title: 'Beta', idea_id: 'idea-1' }),
        mkSessionRow({ id: 's3', title: 'Gamma', idea_id: 'idea-1' }),
      ],
      loading: false,
    })
    useSessionStore.setState({
      ...useSessionStore.getState(),
      archiveSession,
    } as any)

    render(<SessionListColumn onDismiss={() => {}} />)

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    const toggle = screen.getByTestId('v2-session-batch-toggle')
    expect(toggle).not.toBeDisabled()
    fireEvent.click(toggle)

    await vi.waitFor(() => {
      expect(toggle).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByTestId('v2-session-batch-bar')).toBeInTheDocument()
    })
    expect(screen.getByTestId('v2-session-batch-footer')).toBeInTheDocument()
    expect(screen.getAllByTestId('v2-session-row-checkbox')).toHaveLength(3)

    // Idle actions hide while selecting; batch toggle stays.
    expect(screen.queryByRole('button', { name: /Search|搜索/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Alpha'))
    fireEvent.click(screen.getByText('Gamma'))
    expect(screen.getByTestId('v2-session-batch-archive')).toHaveTextContent(/归档 2|Archive 2/)

    fireEvent.click(screen.getByTestId('v2-session-batch-archive'))
    expect(screen.getByTestId('v2-session-batch-archive-confirm')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('v2-session-batch-archive-confirm'))

    await vi.waitFor(() => {
      expect(archiveSession).toHaveBeenCalledTimes(2)
      expect(archiveSession).toHaveBeenCalledWith('s1')
      expect(archiveSession).toHaveBeenCalledWith('s3')
    })
    await vi.waitFor(() => {
      expect(screen.queryByTestId('v2-session-batch-bar')).not.toBeInTheDocument()
    })
  })

  it('keeps failed sessions selected when batch archive partially fails', async () => {
    const archiveSession = vi.fn(async (id: string) => {
      if (id === 's3') return // simulate failure — row stays
      const rows = useSessionListStore.getState().rows.filter((r) => r.id !== id)
      useSessionListStore.setState({ rows })
    })
    useUIStore.setState({ embedMode: true })
    useWorkspaceStore.setState({ workspacePath: '/tmp/ws' })
    useSessionListStore.setState({
      rows: [
        mkSessionRow({ id: 's1', title: 'Alpha', idea_id: null }),
        mkSessionRow({ id: 's2', title: 'Beta', idea_id: 'idea-1' }),
        mkSessionRow({ id: 's3', title: 'Gamma', idea_id: 'idea-1' }),
      ],
      loading: false,
    })
    useSessionStore.setState({
      ...useSessionStore.getState(),
      archiveSession,
    } as any)

    render(<SessionListColumn onDismiss={() => {}} />)
    fireEvent.click(screen.getByTestId('v2-session-batch-toggle'))
    await vi.waitFor(() => {
      expect(screen.getByTestId('v2-session-batch-bar')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Alpha'))
    fireEvent.click(screen.getByText('Gamma'))
    fireEvent.click(screen.getByTestId('v2-session-batch-archive'))
    fireEvent.click(screen.getByTestId('v2-session-batch-archive-confirm'))

    await vi.waitFor(() => {
      expect(screen.getByTestId('v2-session-batch-bar')).toBeInTheDocument()
      expect(screen.getByTestId('v2-session-batch-archive')).toHaveTextContent(/归档 1|Archive 1/)
    })
  })

  it('keeps the normal header actions when not batch-selecting', () => {
    useUIStore.setState({ embedMode: true })
    render(<SessionListColumn onDismiss={() => {}} />)

    expect(screen.getByTestId('v2-session-batch-toggle')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Search|搜索/ })).toBeInTheDocument()
    expect(screen.queryByTestId('v2-session-batch-bar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('v2-session-row-checkbox')).not.toBeInTheDocument()
  })

  it('renders without SidebarProvider (uses safe sidebar defaults)', async () => {
    vi.resetModules()
    vi.doUnmock('@/components/ui/sidebar')
    const { SessionListColumn: Column } = await import('../SessionListColumn')
    expect(() => render(<Column />)).not.toThrow()
    expect(screen.getByTestId('v2-session-list-column')).toBeInTheDocument()
    vi.doMock('@/components/ui/sidebar', () => ({
      SidebarMenu: ({ children }: { children: React.ReactNode }) => <ul>{children}</ul>,
      SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
      SidebarMenuButton: ({ children, isActive: _isActive, ...rest }: React.ComponentProps<'button'> & { isActive?: boolean }) => (
        <button {...rest}>{children}</button>
      ),
      useSidebar: () => ({ state: 'expanded', open: true, setOpen: () => {}, toggleSidebar: () => {} }),
      useSidebarSafe: () => ({ state: 'expanded', open: true, setOpen: () => {}, toggleSidebar: () => {}, openMobile: false, setOpenMobile: () => {}, isMobile: false }),
    }))
  })
})
