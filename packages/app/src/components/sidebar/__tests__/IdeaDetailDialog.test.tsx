import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { IdeaDetailDialog } from '../IdeaDetailDialog'

const t = (_k: string, fallback?: string) => fallback ?? _k

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
}))

vi.mock('@/lib/date-format', () => ({
  formatRelativeTime: () => 'just now',
}))

vi.mock('@/lib/idea-mutations', () => ({
  createIdeaActivity: vi.fn(),
  updateIdea: vi.fn(),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    ideas: {
      getIdeaDetail: vi.fn().mockResolvedValue({
        id: 'idea-1',
        team_id: 'team-1',
        workspace_id: null,
        title: 'Launch beta',
        description: 'Ship the first version.',
        status: 'in_progress',
        created_by_actor_id: 'actor-1',
        created_at: '2026-05-10T00:00:00Z',
        updated_at: '2026-05-11T00:00:00Z',
        activities: [
          {
            id: 'activity-1',
            actor_id: 'actor-1',
            activity_type: 'progress',
            content: 'Started.',
            created_at: '2026-05-11T00:00:00Z',
          },
        ],
        actors: [{ id: 'actor-1', display_name: 'Alice', actor_type: 'member' }],
      }),
    },
  }),
}))

describe('IdeaDetailDialog', () => {
  it('uses the modal-pane detail surface with activity', async () => {
    render(
      <IdeaDetailDialog
        idea={{
          id: 'idea-1',
          title: 'Launch beta',
          status: 'in_progress',
          created_by_actor_id: 'actor-1',
          sort_order: 1000,
          updated_at: '2026-05-11T00:00:00Z',
        }}
        onOpenChange={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByDisplayValue('Launch beta')).toBeInTheDocument())
    expect(screen.getByText('Idea')).toBeInTheDocument()
    expect(screen.getByText('Activity')).toBeInTheDocument()
    expect(screen.getByText('Started.')).toBeInTheDocument()
  })
})
