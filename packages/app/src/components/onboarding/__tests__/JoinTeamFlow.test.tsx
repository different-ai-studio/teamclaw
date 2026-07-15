import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return { ...actual, isTauri: () => true }
})

vi.mock('@/lib/auth/session-store', () => ({
  getFreshAccessToken: vi.fn(async () => 'test-token'),
}))

import { JoinTeamFlow } from '../JoinTeamFlow'
import { useTeamShareStore } from '@/stores/team-share'

function resetStore() {
  useTeamShareStore.setState({
    status: { mode: null, gitRemoteUrl: null, gitAuthKind: null, enabledAt: null },
    loading: false,
    lastError: null,
  })
}

describe('JoinTeamFlow', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    resetStore()
  })

  it('renders "未开通" notice when share mode is null', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'team_share_get_status') return Promise.resolve({ mode: null })
      throw new Error(`unexpected invoke ${cmd}`)
    })

    render(<JoinTeamFlow teamId="t-1" workspacePath="/ws" />)

    await waitFor(() => {
      expect(screen.getByText(/团队共享未开通/)).toBeInTheDocument()
    })
    // team_share_join_existing must NOT be invoked when mode is null.
    expect(
      mockInvoke.mock.calls.find(([c]) => c === 'team_share_join_existing'),
    ).toBeUndefined()
  })

  it('auto-inits and shows secret entry when share mode is oss', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'team_share_get_status') return Promise.resolve({ mode: 'oss' })
      if (cmd === 'team_share_join_existing')
        return Promise.resolve({ initialized: true, shareMode: 'oss' })
      if (cmd === 'team_share_set_team_secret') return Promise.resolve(null)
      throw new Error(`unexpected invoke ${cmd}`)
    })

    const onDone = vi.fn()
    render(<JoinTeamFlow teamId="t-1" workspacePath="/ws" onDone={onDone} />)

    await waitFor(() => {
      expect(screen.getByLabelText(/团队密钥/)).toBeInTheDocument()
    })
    expect(screen.getByText(/模式：oss/)).toBeInTheDocument()
    expect(
      mockInvoke.mock.calls.find(([c]) => c === 'team_share_join_existing'),
    ).toBeTruthy()

    // Enter valid 64-hex secret and save.
    const secret = 'a'.repeat(64)
    const input = screen.getByLabelText(/团队密钥/) as HTMLInputElement
    await userEvent.type(input, secret)
    await userEvent.click(screen.getByRole('button', { name: /保存/ }))

    await waitFor(() => {
      const call = mockInvoke.mock.calls.find(
        ([c]) => c === 'team_share_set_team_secret',
      )
      expect(call).toBeTruthy()
      expect(call?.[1]).toMatchObject({
        teamId: 't-1',
        secretHex: secret,
        workspacePath: '/ws',
      })
    })
    expect(onDone).toHaveBeenCalled()
  })

  it('shows not_opened when join returns initialized=false', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'team_share_get_status') return Promise.resolve({ mode: 'oss' })
      if (cmd === 'team_share_join_existing')
        return Promise.resolve({ initialized: false, shareMode: null })
      throw new Error(`unexpected invoke ${cmd}`)
    })

    render(<JoinTeamFlow teamId="t-1" workspacePath="/ws" />)

    await waitFor(() => {
      expect(screen.getByText(/团队共享未开通/)).toBeInTheDocument()
    })
  })
})
