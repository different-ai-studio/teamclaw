import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ActorsView } from '../ActorsView'

const listActorDirectory = vi.fn()
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    actors: { listActorDirectory },
    auth: { getSession: vi.fn().mockResolvedValue({ user: { id: 'u-1' } }) },
    directory: { resolveFirstMemberActorForUser: vi.fn().mockResolvedValue({ team_id: 'team-1' }) },
  }),
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: Object.assign(
    (sel: any) => sel({ rows: [{ id: 's-1', team_id: 'team-1' }] }),
    {
      subscribe: vi.fn(() => () => {}),
      getState: vi.fn(() => ({ rows: [{ id: 's-1', team_id: 'team-1' }] })),
    },
  ),
}))

vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: 'expanded', sidebarState: 'expanded', open: true, setOpen: vi.fn(), openMobile: false, setOpenMobile: vi.fn(), isMobile: false, toggleSidebar: vi.fn() }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fallback: string) => fallback }),
}))

beforeEach(() => {
  listActorDirectory.mockReset()
})

function mockActorsRows(rows: any[]) {
  listActorDirectory.mockResolvedValue(rows)
}

describe('ActorsView', () => {
  it('renders the actor list surface with team and agent rows', async () => {
    mockActorsRows([
      {
        id: 'a-1',
        actor_type: 'member',
        display_name: 'Alice',
        member_status: 'active',
        agent_status: null,
        last_active_at: null,
      },
      {
        id: 'a-2',
        actor_type: 'agent',
        display_name: 'Reviewer',
        member_status: null,
        agent_status: 'online',
        last_active_at: null,
      },
    ])
    render(<ActorsView />)
    await waitFor(() => expect(screen.getByText('All actors')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText('Team')).toBeInTheDocument()
    expect(screen.getAllByText('Agent').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Search')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter by type')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Alice/ })).toHaveClass('hover:bg-selected')
  })

  it('renders empty state when no actors', async () => {
    mockActorsRows([])
    render(<ActorsView />)
    await waitFor(() => expect(screen.getByText(/no actors in this team yet/i)).toBeInTheDocument())
  })
})
