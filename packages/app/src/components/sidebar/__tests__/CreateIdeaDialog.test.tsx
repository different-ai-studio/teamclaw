import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CreateIdeaDialog } from '../CreateIdeaDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    ideas: {
      createIdea: vi.fn(),
    },
  }),
}))

describe('CreateIdeaDialog', () => {
  it('uses the modal-pane create surface without an activity section', () => {
    render(<CreateIdeaDialog open onOpenChange={vi.fn()} teamId="team-1" />)

    expect(screen.getByText('Idea')).toBeInTheDocument()
    expect(screen.getByText('New idea')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Idea title')).toBeInTheDocument()
    expect(screen.queryByText('Activity')).not.toBeInTheDocument()
  })
})
