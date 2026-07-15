import * as React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { IdeaRow } from '../IdeaRow'
import type { IdeaRow as IdeaRowData } from '@/components/panel/IdeasView'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
}))

const baseIdea: IdeaRowData = {
  id: 'idea-1',
  title: 'Ship it',
  status: 'open',
  created_by_actor_id: 'a-1',
  sort_order: 1000,
  updated_at: new Date().toISOString(),
}

function setup(overrides: Partial<React.ComponentProps<typeof IdeaRow>> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onView: vi.fn(),
    onChangeStatus: vi.fn(),
    onRequestRename: vi.fn(),
    onCopyId: vi.fn(),
    onRequestDelete: vi.fn(),
  }
  render(<IdeaRow idea={baseIdea} active={false} {...handlers} {...overrides} />)
  return handlers
}

function openMenu() {
  const trigger = screen.getByText('Ship it').closest('button')!
  // Radix ContextMenu listens on pointerdown with button === 2
  fireEvent.pointerDown(trigger, { button: 2, ctrlKey: false })
  fireEvent.contextMenu(trigger)
}

describe('IdeaRow', () => {
  it('left click → onSelect', () => {
    const h = setup()
    fireEvent.click(screen.getByText('Ship it'))
    expect(h.onSelect).toHaveBeenCalledWith(baseIdea)
  })

  it('renders status as a compact dot only', () => {
    setup({ idea: { ...baseIdea, status: 'in_progress' } })
    expect(screen.getByLabelText('in progress')).toBeInTheDocument()
    expect(screen.queryByText('active')).not.toBeInTheDocument()
    expect(screen.queryByText(/in progress/i)).not.toBeInTheDocument()
  })

  it('View → onView', async () => {
    const h = setup()
    openMenu()
    fireEvent.click(await screen.findByText('View'))
    expect(h.onView).toHaveBeenCalledWith(baseIdea)
  })

  it('Rename → onRequestRename', async () => {
    const h = setup()
    openMenu()
    fireEvent.click(await screen.findByText('Rename'))
    expect(h.onRequestRename).toHaveBeenCalledWith(baseIdea)
  })

  it('Copy ID → onCopyId', async () => {
    const h = setup()
    openMenu()
    fireEvent.click(await screen.findByText('Copy ID'))
    expect(h.onCopyId).toHaveBeenCalledWith(baseIdea)
  })

  it('Delete → onRequestDelete', async () => {
    const h = setup()
    openMenu()
    fireEvent.click(await screen.findByText('Delete'))
    expect(h.onRequestDelete).toHaveBeenCalledWith(baseIdea)
  })

  // NOTE: Status submenu test omitted — jsdom does not propagate Radix pointer
  // events through SubTrigger → SubContent reliably. Manual QA covers this path.
})
