import * as React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ActorRow } from '../ActorRow'
import type { ActorRow as ActorRowData } from '@/components/panel/ActorsView'

const currentTeamStoreMocks = vi.hoisted(() => ({
  currentMember: { id: 'me-1', role: 'admin' } as { id: string; role: string } | null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string) => fallback ?? _k,
  }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (s: { team: null; currentMember: typeof currentTeamStoreMocks.currentMember }) => unknown) =>
    selector({ team: null, currentMember: currentTeamStoreMocks.currentMember }),
}))

vi.mock('@/stores/member-preferences-store', () => ({
  useMemberPreferencesStore: (selector: (s: { setDefaultAgent: () => void }) => unknown) =>
    selector({ setDefaultAgent: vi.fn() }),
}))

const baseActor: ActorRowData = {
  id: 'actor-1',
  actor_type: 'member',
  display_name: 'Alice',
  member_status: null,
  agent_status: null,
  last_active_at: null,
}

function setup(overrides: Partial<React.ComponentProps<typeof ActorRow>> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onViewDetail: vi.fn(),
    onCopyName: vi.fn(),
    onCopyId: vi.fn(),
    onRequestRemove: vi.fn(),
  }
  render(<ActorRow actor={baseActor} active={false} {...handlers} {...overrides} />)
  return handlers
}

function openMenu() {
  const trigger = screen.getByText('Alice').closest('button')!
  // Radix ContextMenu listens on pointerdown with button === 2
  fireEvent.pointerDown(trigger, { button: 2, ctrlKey: false })
  fireEvent.contextMenu(trigger)
}

describe('ActorRow', () => {
  it('left click selects', () => {
    const h = setup()
    fireEvent.click(screen.getByText('Alice'))
    expect(h.onSelect).toHaveBeenCalledWith(baseActor)
  })

  it('labels agent actors as Agent', () => {
    setup({
      actor: {
        ...baseActor,
        actor_type: 'agent',
        display_name: 'Macmini',
      },
    })

    expect(screen.getByText('Agent')).toBeInTheDocument()
    expect(screen.queryByText('AI')).not.toBeInTheDocument()
  })

  it('right click → View profile → onViewDetail', async () => {
    const h = setup()
    openMenu()
    fireEvent.click(await screen.findByText('View profile'))
    expect(h.onViewDetail).toHaveBeenCalledWith(baseActor)
  })

  it('right click → Copy name → onCopyName', async () => {
    const h = setup()
    openMenu()
    fireEvent.click(await screen.findByText('Copy name'))
    expect(h.onCopyName).toHaveBeenCalledWith(baseActor)
  })

  it('right click → Copy ID → onCopyId', async () => {
    const h = setup()
    openMenu()
    fireEvent.click(await screen.findByText('Copy ID'))
    expect(h.onCopyId).toHaveBeenCalledWith(baseActor)
  })

  it('right click → Remove from team → onRequestRemove when admin', async () => {
    const h = setup()
    openMenu()
    fireEvent.click(await screen.findByText('Remove from team'))
    expect(h.onRequestRemove).toHaveBeenCalledWith(baseActor)
  })

  it('hides Remove from team for non-admin', async () => {
    currentTeamStoreMocks.currentMember = { id: 'me-1', role: 'member' }
    setup()
    openMenu()
    expect(screen.queryByText('Remove from team')).not.toBeInTheDocument()
    currentTeamStoreMocks.currentMember = { id: 'me-1', role: 'admin' }
  })
})
