import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContactsNavEntry } from '../ContactsNavEntry'
import { useUIStore } from '@/stores/ui'

vi.mock('@/components/sidebar/InviteActorDialog', () => ({
  InviteActorDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="invite-dialog" /> : null,
}))

describe('ContactsNavEntry', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarFilter: { kind: 'all' } })
  })

  it('main area sets filter to actors', () => {
    render(<ContactsNavEntry />)
    fireEvent.click(screen.getByRole('button', { name: /联系人|Contacts/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'actors' })
  })

  it('invite button opens invite dialog without changing filter', () => {
    render(<ContactsNavEntry />)
    fireEvent.click(screen.getByRole('button', { name: /邀请加入团队|Invite to team/ }))
    expect(screen.getByTestId('invite-dialog')).toBeInTheDocument()
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'all' })
  })
})
