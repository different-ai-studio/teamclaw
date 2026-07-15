import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NavRail } from '../NavRail'
import { useUIStore } from '@/stores/ui'
import { useSessionStore } from '@/stores/session'
import { useSessionListStore } from '@/stores/session-list-store'
import { useCronStore } from '@/stores/cron'

const mkListRow = (id: string, title: string) => ({
  id,
  title,
  team_id: 't1',
  last_message_at: null,
  last_message_preview: null,
  mode: 'collab' as const,
  idea_id: null,
  has_unread: false,
  created_at: '',
  updated_at: '',
})

vi.mock('@/components/sidebar/ActorsSection', () => ({
  ActorsSection: () => <div data-testid="actors-section" />,
}))
vi.mock('@/components/sidebar/NewChatSplitButton', () => ({
  NewChatSplitButton: () => <div data-testid="new-chat-split" />,
}))
vi.mock('@/hooks/use-quick-chat-readiness', () => ({
  useQuickChatReadiness: () => ({
    kind: 'ready',
    target: { agentId: 'a1', displayName: 'Bot', source: 'local' },
  }),
}))
vi.mock('sonner', () => ({
  toast: vi.fn(),
}))

describe('NavRail', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarFilter: { kind: 'all' }, embedMode: false })
    useSessionListStore.setState({
      rows: [mkListRow('s1', 'A'), mkListRow('s2', 'B')],
      pinnedSessionIds: [],
    })
    useCronStore.setState({
      cronSessionIds: new Set<string>(),
      showCronSessions: false,
    })
    useSessionStore.setState({ sessions: [] })
  })

  it('clicking Sessions sets filter to { kind: "all" }', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'pinned' } })
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /会话/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'all' })
  })

  it('clicking Sessions exits the clock-only session view', () => {
    useCronStore.setState({ showCronSessions: true })
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /会话/ }))
    expect(useCronStore.getState().showCronSessions).toBe(false)
  })

  it('clicking Pinned sets filter to { kind: "pinned" }', () => {
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /已置顶/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'pinned' })
  })

  it('clicking Shortcuts sets filter to { kind: "shortcuts" }', () => {
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /快捷方式/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'shortcuts' })
  })

  it('shows session count badge in Sessions row', () => {
    render(<NavRail />)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('keeps session count when legacy session store is empty', () => {
    useSessionStore.setState({ sessions: [] })
    useSessionListStore.setState({
      rows: [mkListRow('s1', 'A'), mkListRow('s2', 'B'), mkListRow('s3', 'C')],
    })
    render(<NavRail />)
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('shows pinned count badge in Pinned row', () => {
    useSessionListStore.setState({
      rows: [mkListRow('s1', 'A'), mkListRow('s2', 'B')],
      pinnedSessionIds: ['s1'],
    })
    render(<NavRail />)
    const pinnedButton = screen.getByRole('button', { name: /Pinned|已置顶/ })
    expect(pinnedButton).toHaveTextContent('1')
  })

  it('renders ActorsSection and an Ideas filter entry', () => {
    render(<NavRail />)
    expect(screen.getByTestId('actors-section')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Ideas|想法/ })).toBeInTheDocument()
  })

  it('hides Ideas and Shortcuts in embed (plugin) mode', () => {
    useUIStore.setState({ embedMode: true })
    render(<NavRail />)
    expect(screen.queryByRole('button', { name: /Ideas|想法/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /快捷方式|Shortcuts/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /会话|Sessions/ })).toBeInTheDocument()
  })
})
