import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewSessionActorPicker } from '../NewSessionActorPicker'

const supabaseFrom = vi.fn()
vi.mock('@/lib/supabase-client', () => ({
  supabase: { from: (...args: unknown[]) => supabaseFrom(...args) },
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback: string) => fallback }),
}))

function mockActors(rows: { id: string; actor_type: string; display_name: string }[]) {
  supabaseFrom.mockImplementation(() => ({
    select: () => ({
      eq: () => ({
        in: () => Promise.resolve({ data: rows, error: null }),
      }),
    }),
  }))
}

beforeEach(() => { supabaseFrom.mockReset() })

describe('NewSessionActorPicker', () => {
  it('renders members and agents, calls onConfirm with selected ids when Send clicked', async () => {
    mockActors([
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
      { id: 'a-1', actor_type: 'agent', display_name: 'Bot' },
    ])
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    render(
      <NewSessionActorPicker
        open={true}
        onCancel={() => {}}
        onConfirm={onConfirm}
        teamId="t-1"
        selfActorId={null}
      />
    )
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    await user.click(screen.getByText('Alice'))
    await user.click(screen.getByText('Send'))
    expect(onConfirm).toHaveBeenCalledWith({
      members: [{ id: 'm-1', displayName: 'Alice' }],
      agents: [],
    })
  })

  it('Skip sends empty arrays', async () => {
    mockActors([{ id: 'a-1', actor_type: 'agent', display_name: 'Bot' }])
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    render(
      <NewSessionActorPicker
        open={true}
        onCancel={() => {}}
        onConfirm={onConfirm}
        teamId="t-1"
        selfActorId={null}
      />
    )
    await waitFor(() => expect(screen.getByText('Bot')).toBeInTheDocument())
    await user.click(screen.getByText('Skip'))
    expect(onConfirm).toHaveBeenCalledWith({ members: [], agents: [] })
  })

  it('excludes selfActorId from the list', async () => {
    mockActors([
      { id: 'self', actor_type: 'member', display_name: 'Me' },
      { id: 'm-1', actor_type: 'member', display_name: 'Alice' },
    ])
    render(
      <NewSessionActorPicker
        open={true}
        onCancel={() => {}}
        onConfirm={() => {}}
        teamId="t-1"
        selfActorId="self"
      />
    )
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(screen.queryByText('Me')).toBeNull()
  })
})
