import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NavRail } from '../NavRail'
import { useUIStore } from '@/stores/ui'
import { useSessionStore } from '@/stores/session'

vi.mock('@/components/sidebar/IdeasSection', () => ({
  IdeasSection: () => <div data-testid="ideas-section" />,
}))
vi.mock('@/components/sidebar/ActorsSection', () => ({
  ActorsSection: () => <div data-testid="actors-section" />,
}))
vi.mock('sonner', () => ({
  toast: vi.fn(),
}))

describe('NavRail', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarFilter: { kind: 'all' } })
    useSessionStore.setState({ sessions: [
      { id: 's1', title: 'A', messages: [], createdAt: new Date(), updatedAt: new Date() },
      { id: 's2', title: 'B', messages: [], createdAt: new Date(), updatedAt: new Date() },
    ] as any })
  })

  it('clicking Sessions sets filter to { kind: "all" }', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'pinned' } })
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /Sessions/i }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'all' })
  })

  it('clicking Pinned sets filter to { kind: "pinned" }', () => {
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /Pinned/i }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'pinned' })
  })

  it('clicking Shortcuts sets filter to { kind: "shortcuts" }', () => {
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /Shortcuts/i }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'shortcuts' })
  })

  it('shows session count badge in Sessions row', () => {
    render(<NavRail />)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renders IdeasSection and ActorsSection', () => {
    render(<NavRail />)
    expect(screen.getByTestId('ideas-section')).toBeInTheDocument()
    expect(screen.getByTestId('actors-section')).toBeInTheDocument()
  })
})
