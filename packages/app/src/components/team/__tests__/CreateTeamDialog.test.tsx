import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('@/lib/auth/session-store', () => ({
  getFreshAccessToken: vi.fn(async () => 'test-token'),
}))

import { CreateTeamDialog } from '../CreateTeamDialog'

function Harness({
  onCreated,
}: {
  onCreated?: (r: { team_id: string; team_slug: string }) => void
}) {
  const [open, setOpen] = React.useState(true)
  return (
    <CreateTeamDialog
      workspacePath="/ws"
      open={open}
      onOpenChange={setOpen}
      onCreated={onCreated}
    />
  )
}

describe('CreateTeamDialog', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it('disables the 创建 button when name is empty, enables once typed', async () => {
    render(<Harness />)

    const submit = await screen.findByRole('button', { name: '创建' })
    expect(submit).toBeDisabled()

    const input = screen.getByLabelText('团队名称')
    fireEvent.change(input, { target: { value: 'alpha' } })

    expect(submit).not.toBeDisabled()
  })

  it('invokes team_share_create and calls onCreated on success', async () => {
    mockInvoke.mockResolvedValueOnce({ team_id: 't1', team_slug: 'alpha' })
    const onCreated = vi.fn()

    render(<Harness onCreated={onCreated} />)

    fireEvent.change(screen.getByLabelText('团队名称'), {
      target: { value: 'alpha' },
    })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('team_share_create', {
        name: 'alpha',
        workspacePath: '/ws',
        accessToken: 'test-token',
      })
    })
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith({
        team_id: 't1',
        team_slug: 'alpha',
      })
    })
  })

  it('shows error and keeps dialog open when invoke rejects', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('boom'))

    render(<Harness />)

    fireEvent.change(screen.getByLabelText('团队名称'), {
      target: { value: 'alpha' },
    })
    const submit = screen.getByRole('button', { name: '创建' })
    fireEvent.click(submit)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/boom/)

    // Button re-enabled after failure (name still present).
    await waitFor(() => expect(submit).not.toBeDisabled())
    // Dialog still rendered.
    expect(screen.getByLabelText('团队名称')).toBeInTheDocument()
  })
})
