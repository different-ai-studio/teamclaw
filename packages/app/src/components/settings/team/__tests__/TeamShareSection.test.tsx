import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockInvoke = vi.hoisted(() => vi.fn())
const authState = vi.hoisted(() => ({
  session: { user: { id: 'u1' } } as unknown,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>(
    '@/lib/utils',
  )
  return { ...actual, isTauri: () => true }
})

// TeamShareSection gates its status fetch on a logged-in session.
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (sel: (s: { session: unknown }) => unknown) => sel(authState),
}))

// The team-share store now fetches a fresh access token before invoking Tauri.
vi.mock('@/lib/auth/session-store', () => ({
  getFreshAccessToken: vi.fn(async () => 'test-token'),
}))

// ---------------------------------------------------------------------------
// SUT — imported after mocks
// ---------------------------------------------------------------------------
import { TeamShareSection } from '../TeamShareSection'
import { TeamSecretEntry } from '../TeamSecretEntry'
import { useTeamShareStore } from '@/stores/team-share'

function resetStore() {
  useTeamShareStore.setState({
    status: {
      mode: null,
      gitRemoteUrl: null,
      gitAuthKind: null,
      enabledAt: null,
    },
    loading: false,
    lastError: null,
  })
}

describe('TeamShareSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
    authState.session = { user: { id: 'u1' } }
  })

  it('shows a sign-in prompt and skips the status fetch when signed out', async () => {
    authState.session = null
    mockInvoke.mockResolvedValue({ mode: null })

    render(
      <TeamShareSection teamId="team-1" workspacePath="/workspace" isOwner={true} />,
    )

    expect(screen.getByText(/请先登录/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /开通/ })).toBeNull()
    expect(mockInvoke).not.toHaveBeenCalledWith('team_share_get_status', expect.anything())
  })

  it('renders "团队共享未开通" when mode is null', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'team_share_get_status') {
        return Promise.resolve({ mode: null })
      }
      return Promise.resolve(null)
    })

    render(
      <TeamShareSection
        teamId="team-1"
        workspacePath="/workspace"
        isOwner={true}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/团队共享未开通/)).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: /开通/ })).toBeTruthy()
    expect(mockInvoke).toHaveBeenCalledWith('team_share_get_status', {
      teamId: 'team-1',
      workspacePath: '/workspace',
      accessToken: 'test-token',
    })
  })

  it('hides the 开通 button for non-owners', async () => {
    mockInvoke.mockImplementation(() => Promise.resolve({ mode: null }))

    render(
      <TeamShareSection
        teamId="team-1"
        workspacePath="/workspace"
        isOwner={false}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/团队共享未开通/)).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: /开通/ })).toBeNull()
  })

  it('calls onConfigured after the wizard succeeds', async () => {
    const onConfigured = vi.fn()
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'team_share_get_status') {
        return Promise.resolve({ mode: null })
      }
      if (cmd === 'team_share_enable_oss') {
        return Promise.resolve({
          teamId: 'team-1',
          shareMode: 'oss',
          cloneWarning: null,
        })
      }
      return Promise.resolve(null)
    })

    render(
      <TeamShareSection
        teamId="team-1"
        workspacePath="/workspace"
        isOwner={true}
        onConfigured={onConfigured}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /开通/ })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /开通/ }))
    await waitFor(() => {
      expect(screen.getByText(/开通团队共享/)).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /确认开通/ }))

    await waitFor(() => {
      expect(onConfigured).toHaveBeenCalledTimes(1)
    })
  })

  it('opens wizard, enables OSS, then shows "已开通: OSS"', async () => {
    let statusCallCount = 0
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'team_share_get_status') {
        statusCallCount += 1
        // First call: not enabled. After enable: enabled.
        return Promise.resolve(
          statusCallCount === 1 ? { mode: null } : { mode: 'oss' },
        )
      }
      if (cmd === 'team_share_enable_oss') {
        return Promise.resolve({
          teamId: 'team-1',
          shareMode: 'oss',
          cloneWarning: null,
        })
      }
      return Promise.resolve(null)
    })

    render(
      <TeamShareSection
        teamId="team-1"
        workspacePath="/workspace"
        isOwner={true}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /开通/ })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /开通/ }))

    // Wizard opens — OSS is the default selection
    await waitFor(() => {
      expect(screen.getByText(/开通团队共享/)).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /确认开通/ }))

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('team_share_enable_oss', {
        teamId: 'team-1',
        workspacePath: '/workspace',
        accessToken: 'test-token',
        teamSecretHex: null,
      })
    })

    await waitFor(() => {
      expect(screen.getByText(/已开通/)).toBeTruthy()
      expect(screen.getByText('OSS')).toBeTruthy()
    })
  })
})

describe('TeamSecretEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
  })

  it('derives a 64-hex key from an arbitrary passphrase', async () => {
    mockInvoke.mockResolvedValue(undefined)

    render(
      <TeamSecretEntry teamId="team-1" workspacePath="/workspace" />,
    )

    const input = screen.getByLabelText(/团队密钥/) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'my team passphrase' } })

    const saveBtn = screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement
    await waitFor(() => expect(saveBtn.disabled).toBe(false))

    fireEvent.click(saveBtn)

    // A mount-time `team_share_get_team_secret` read may also fire; assert on
    // the save call specifically rather than a strict total count.
    await waitFor(() =>
      expect(
        mockInvoke.mock.calls.find(([c]) => c === 'team_share_set_team_secret'),
      ).toBeTruthy(),
    )
    const [cmd, payload] = mockInvoke.mock.calls.find(
      ([c]) => c === 'team_share_set_team_secret',
    )!
    expect(cmd).toBe('team_share_set_team_secret')
    expect(payload.teamId).toBe('team-1')
    expect(payload.workspacePath).toBe('/workspace')
    // Non-hex passphrase is SHA-256 derived to a 64-hex key.
    expect(payload.secretHex).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects an empty input', async () => {
    render(
      <TeamSecretEntry teamId="team-1" workspacePath="/workspace" />,
    )

    const saveBtn = screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    // The mount-time secret read may fire, but no save must happen for empty input.
    expect(
      mockInvoke.mock.calls.find(([c]) => c === 'team_share_set_team_secret'),
    ).toBeUndefined()
  })

  it('accepts 64 hex chars and calls team_share_set_team_secret', async () => {
    mockInvoke.mockResolvedValue(undefined)
    const hex = 'ab'.repeat(32) // 64 hex chars

    render(
      <TeamSecretEntry teamId="team-1" workspacePath="/workspace" />,
    )

    const input = screen.getByLabelText(/团队密钥/)
    fireEvent.change(input, { target: { value: hex } })

    const saveBtn = screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement
    await waitFor(() => expect(saveBtn.disabled).toBe(false))

    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('team_share_set_team_secret', {
        teamId: 'team-1',
        secretHex: hex,
        workspacePath: '/workspace',
      })
    })

    await waitFor(() => {
      expect(screen.getByText(/已保存/)).toBeTruthy()
    })
  })
})
