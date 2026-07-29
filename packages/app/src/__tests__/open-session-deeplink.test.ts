import { beforeEach, describe, expect, it, vi } from 'vitest'

const UUID = '33c0b7a2-385d-4f77-b92c-9801819530bd'
const TEAM_A = 'team-a'
const TEAM_B = 'team-b'

const mocks = vi.hoisted(() => ({
  joinSession: vi.fn(),
  enterTeam: vi.fn(),
  switchToSession: vi.fn(),
  load: vi.fn(),
  session: { user: { id: 'user-1', is_anonymous: false } } as
    | { user: { id: string; is_anonymous?: boolean } }
    | null,
  teamId: 'team-a' as string | null,
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    sessions: { joinSession: mocks.joinSession },
  }),
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({ session: mocks.session }),
  },
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({
      team: mocks.teamId ? { id: mocks.teamId } : null,
      enterTeam: mocks.enterTeam,
    }),
  },
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({ switchToSession: mocks.switchToSession }),
  },
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: {
    getState: () => ({ load: mocks.load }),
  },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}))

import {
  clearPendingSessionDeeplink,
  completePendingSessionDeeplink,
  openSessionFromDeeplink,
  readPendingSessionDeeplink,
  stashPendingSessionDeeplink,
} from '@/lib/open-session-deeplink'

describe('openSessionFromDeeplink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.session = { user: { id: 'user-1', is_anonymous: false } }
    mocks.teamId = TEAM_A
    mocks.joinSession.mockResolvedValue({ team_id: TEAM_A })
    mocks.enterTeam.mockResolvedValue(undefined)
    mocks.switchToSession.mockResolvedValue(undefined)
    mocks.load.mockResolvedValue(undefined)
  })

  it('stashes the session when auth is not ready', async () => {
    mocks.session = null
    const ok = await openSessionFromDeeplink(UUID)
    expect(ok).toBe(false)
    expect(readPendingSessionDeeplink()?.sessionId).toBe(UUID)
    expect(mocks.joinSession).not.toHaveBeenCalled()
  })

  it('navigates immediately when the session is in the active team', async () => {
    const ok = await openSessionFromDeeplink(UUID)
    expect(ok).toBe(true)
    expect(mocks.joinSession).toHaveBeenCalledWith(UUID)
    expect(mocks.enterTeam).not.toHaveBeenCalled()
    expect(mocks.switchToSession).toHaveBeenCalledWith(UUID)
    expect(mocks.load).toHaveBeenCalled()
    expect(readPendingSessionDeeplink()).toBeNull()
  })

  it('defers navigation across team switches', async () => {
    mocks.joinSession.mockResolvedValue({ team_id: TEAM_B })
    mocks.teamId = TEAM_A

    const ok = await openSessionFromDeeplink(UUID)
    expect(ok).toBe(true)
    expect(mocks.enterTeam).toHaveBeenCalledWith(TEAM_B)
    expect(mocks.switchToSession).not.toHaveBeenCalled()
    expect(readPendingSessionDeeplink()).toEqual({ sessionId: UUID, teamId: TEAM_B })
  })
})

describe('completePendingSessionDeeplink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.session = { user: { id: 'user-1', is_anonymous: false } }
    mocks.teamId = TEAM_B
    mocks.switchToSession.mockResolvedValue(undefined)
    mocks.load.mockResolvedValue(undefined)
  })

  it('opens the stashed session once the target team is active', async () => {
    stashPendingSessionDeeplink(UUID, TEAM_B)
    const ok = await completePendingSessionDeeplink()
    expect(ok).toBe(true)
    expect(mocks.switchToSession).toHaveBeenCalledWith(UUID)
    expect(readPendingSessionDeeplink()).toBeNull()
  })

  it('waits until the active team matches the pending target team', async () => {
    stashPendingSessionDeeplink(UUID, TEAM_B)
    mocks.teamId = TEAM_A
    const ok = await completePendingSessionDeeplink()
    expect(ok).toBe(false)
    expect(mocks.switchToSession).not.toHaveBeenCalled()
    expect(readPendingSessionDeeplink()?.sessionId).toBe(UUID)
  })
})

describe('pending session deeplink storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips through localStorage', () => {
    stashPendingSessionDeeplink(UUID, TEAM_A)
    expect(readPendingSessionDeeplink()).toEqual({ sessionId: UUID, teamId: TEAM_A })
    clearPendingSessionDeeplink()
    expect(readPendingSessionDeeplink()).toBeNull()
  })
})
