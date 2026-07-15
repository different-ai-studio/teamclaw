import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IdeasView } from '../IdeasView'

const listIdeasMock = vi.fn()
const listActorDirectoryMock = vi.fn()
const updateIdeaMock = vi.fn()

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    auth: { getSession: vi.fn().mockResolvedValue({ user: { id: 'u-1' } }) },
    directory: { resolveFirstMemberActorForUser: vi.fn().mockResolvedValue(null) },
    ideas: {
      listIdeas: listIdeasMock,
      updateIdea: updateIdeaMock,
    },
    actors: {
      listActorDirectory: listActorDirectoryMock,
    },
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

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: Object.assign(
    (sel: any) => sel({ team: { id: 'team-1', name: 'Team One', slug: 'team-one' } }),
    {
      subscribe: vi.fn(() => () => {}),
      getState: vi.fn(() => ({ team: { id: 'team-1', name: 'Team One', slug: 'team-one' } })),
    },
  ),
}))

vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: 'expanded', sidebarState: 'expanded', open: true, setOpen: vi.fn(), openMobile: false, setOpenMobile: vi.fn(), isMobile: false, toggleSidebar: vi.fn() }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fallback: string) => fallback }),
}))

vi.mock('@/lib/date-format', () => ({
  formatRelativeTime: () => 'just now',
}))

vi.mock('@/components/sidebar/IdeaDetailDialog', () => ({
  IdeaDetailDialog: ({ idea }: { idea: { title: string } | null }) => (
    idea ? <div data-testid="idea-detail-panel">{idea.title}</div> : null
  ),
}))

beforeEach(() => {
  listIdeasMock.mockReset()
  listActorDirectoryMock.mockReset()
  updateIdeaMock.mockReset()
  updateIdeaMock.mockResolvedValue(undefined)
  vi.useRealTimers()
})

function mockIdeasResponse(ideas: any[], actors: any[]) {
  listIdeasMock.mockResolvedValue(ideas)
  listActorDirectoryMock.mockResolvedValue(actors)
}

describe('IdeasView', () => {
  it('renders ideas with title and creator name', async () => {
    mockIdeasResponse(
      [
        { id: 'i-1', title: 'Launch beta', status: 'in_progress', created_by_actor_id: 'a-1', sort_order: 1000, updated_at: '2026-05-10T00:00:00Z' },
      ],
      [{ id: 'a-1', display_name: 'Alice' }],
    )
    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText('Ideas')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('Launch beta')).toBeInTheDocument())
    expect(screen.getByText(/Alice/)).toBeInTheDocument()
    expect(screen.getByLabelText(/in progress/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Search')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter by status')).toBeInTheDocument()
    expect(screen.getByLabelText('Drag idea Launch beta')).toHaveClass('hover:bg-selected')
  })

  it('renders empty state when no ideas', async () => {
    mockIdeasResponse([], [])
    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText(/no ideas yet/i)).toBeInTheDocument())
  })

  it('opens idea detail panel when an idea row is clicked', async () => {
    mockIdeasResponse(
      [
        { id: 'i-1', title: 'Launch beta', status: 'open', created_by_actor_id: 'a-1', sort_order: 1000, updated_at: '2026-05-10T00:00:00Z' },
      ],
      [{ id: 'a-1', display_name: 'Alice' }],
    )
    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText('Launch beta')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('Drag idea Launch beta'))

    expect(screen.getByTestId('idea-detail-panel')).toHaveTextContent('Launch beta')
  })

  it('long-press drag reorders ideas and persists sort order', async () => {
    mockIdeasResponse(
      [
        { id: 'i-1', title: 'First idea', status: 'open', created_by_actor_id: 'a-1', sort_order: 1000, updated_at: '2026-05-10T00:00:00Z' },
        { id: 'i-2', title: 'Second idea', status: 'open', created_by_actor_id: 'a-1', sort_order: 2000, updated_at: '2026-05-11T00:00:00Z' },
        { id: 'i-3', title: 'Third idea', status: 'open', created_by_actor_id: 'a-1', sort_order: 3000, updated_at: '2026-05-12T00:00:00Z' },
      ],
      [{ id: 'a-1', display_name: 'Alice' }],
    )

    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText('First idea')).toBeInTheDocument())

    fireEvent.pointerDown(screen.getByLabelText('Drag idea First idea'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    fireEvent.pointerEnter(screen.getByLabelText('Drag idea Third idea'))
    fireEvent.pointerUp(screen.getByLabelText('Drag idea Third idea'))

    await waitFor(() => {
      expect(updateIdeaMock).toHaveBeenCalledWith({ ideaId: 'i-1', sortOrder: 3000 })
    })
    expect(updateIdeaMock).toHaveBeenCalledWith({ ideaId: 'i-2', sortOrder: 1000 })
    expect(updateIdeaMock).toHaveBeenCalledWith({ ideaId: 'i-3', sortOrder: 2000 })
  })
})
