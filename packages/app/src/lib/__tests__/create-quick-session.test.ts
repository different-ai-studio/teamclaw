import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQuickSession } from '../create-quick-session'

const mocks = vi.hoisted(() => ({
  teamId: 'team-1' as string | null,
  target: null as { agentId: string; displayName: string; source: 'local' } | null,
  created: { sessionId: 'sess-1' } as { sessionId: string } | null,
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: mocks.teamId ? { id: mocks.teamId } : null }),
  },
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/ws' }),
  },
}))

vi.mock('../resolve-quick-chat-target', () => ({
  resolveQuickChatTarget: vi.fn(async () => mocks.target),
}))

vi.mock('../quick-empty-session', () => ({
  createQuickEmptySession: vi.fn(async () => mocks.created),
}))

describe('createQuickSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.teamId = 'team-1'
    mocks.target = { agentId: 'a1', displayName: 'Bot', source: 'local' }
    mocks.created = { sessionId: 'sess-1' }
  })

  it('fails with no_team when no team', async () => {
    mocks.teamId = null
    expect(await createQuickSession()).toEqual({ ok: false, reason: 'no_team' })
  })

  it('fails with no_agent when resolver returns null', async () => {
    mocks.target = null
    expect(await createQuickSession()).toEqual({ ok: false, reason: 'no_agent' })
  })

  it('fails with no_actor when createQuickEmptySession returns null', async () => {
    mocks.created = null
    expect(await createQuickSession()).toEqual({ ok: false, reason: 'no_actor' })
  })

  it('fails with server_error when createQuickEmptySession throws', async () => {
    const { createQuickEmptySession } = await import('../quick-empty-session')
    const boom = new Error('backend down')
    vi.mocked(createQuickEmptySession).mockRejectedValueOnce(boom)
    const result = await createQuickSession()
    expect(result).toEqual({ ok: false, reason: 'server_error', error: boom })
  })

  it('creates session with resolved target', async () => {
    const { createQuickEmptySession } = await import('../quick-empty-session')
    const result = await createQuickSession()
    expect(result).toEqual({ ok: true, sessionId: 'sess-1', agentDisplayName: 'Bot' })
    expect(createQuickEmptySession).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalActorIds: ['a1'],
        titleName: 'Bot',
        runtimeReason: 'quick_session_local',
      }),
    )
  })

  it('uses target override without calling resolver again', async () => {
    const { resolveQuickChatTarget } = await import('../resolve-quick-chat-target')
    const override = { agentId: 'a2', displayName: 'Cloud', source: 'team_default' as const }
    const result = await createQuickSession(override)
    expect(result).toEqual({ ok: true, sessionId: 'sess-1', agentDisplayName: 'Cloud' })
    expect(resolveQuickChatTarget).not.toHaveBeenCalled()
  })
})
