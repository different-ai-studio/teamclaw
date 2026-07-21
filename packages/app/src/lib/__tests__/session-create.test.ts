import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentType } from '@/lib/proto/amux_pb'

const mockRuntimeStart = vi.fn().mockResolvedValue({
  accepted: true,
  runtimeId: 'rt-1',
  sessionId: 'sess-1',
  rejectedReason: '',
})
const mockSetModel = vi.fn().mockResolvedValue({})

const backendMocks = vi.hoisted(() => ({
  createSessionShell: vi.fn(),
  insertOutgoingMessage: vi.fn(),
  listLatestAgentRuntimeHints: vi.fn(),
  fetchLatestRuntimeForSession: vi.fn(),
  listAgentDefaults: vi.fn(),
  listActorDirectoryByIds: vi.fn(),
  listDaemonWorkspaces: vi.fn(),
  createDaemonWorkspace: vi.fn(),
}))

const workspaceStoreMocks = vi.hoisted(() => ({
  workspacePath: '',
}))

const daemonAdminMocks = vi.hoisted(() => ({
  getLocalDaemonActorId: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('@/lib/daemon-agent-admin', () => ({
  getLocalDaemonActorId: (...args: unknown[]) => daemonAdminMocks.getLocalDaemonActorId(...args),
}))

vi.mock('@/lib/teamclaw-rpc', () => ({
  runtimeStart: (...args: unknown[]) => mockRuntimeStart(...args),
  setModel: (...args: unknown[]) => mockSetModel(...args),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    sessions: {
      createSessionShell: backendMocks.createSessionShell,
    },
    messages: {
      insertOutgoingMessage: backendMocks.insertOutgoingMessage,
    },
    runtime: {
      listLatestAgentRuntimeHints: backendMocks.listLatestAgentRuntimeHints,
      fetchLatestRuntimeForSession: backendMocks.fetchLatestRuntimeForSession,
      listAgentDefaults: backendMocks.listAgentDefaults,
    },
    actors: {
      listActorDirectoryByIds: backendMocks.listActorDirectoryByIds,
    },
    workspaces: {
      listDaemonWorkspaces: backendMocks.listDaemonWorkspaces,
      createDaemonWorkspace: backendMocks.createDaemonWorkspace,
    },
  }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: workspaceStoreMocks.workspacePath }),
  },
}))

vi.mock('@/lib/current-actor', () => ({
  resolveCurrentMemberActorId: vi.fn().mockResolvedValue('member-1'),
}))

describe('startAgentRuntimesAsync', () => {
  beforeEach(() => {
    mockRuntimeStart.mockClear()
    mockSetModel.mockClear()
    backendMocks.createSessionShell.mockReset()
    backendMocks.insertOutgoingMessage.mockReset()
    backendMocks.listLatestAgentRuntimeHints.mockReset()
    backendMocks.fetchLatestRuntimeForSession.mockReset()
    backendMocks.listAgentDefaults.mockReset()
    backendMocks.listActorDirectoryByIds.mockReset()
    backendMocks.listDaemonWorkspaces.mockReset()
    backendMocks.createDaemonWorkspace.mockReset()
    daemonAdminMocks.getLocalDaemonActorId.mockReset()
    daemonAdminMocks.getLocalDaemonActorId.mockResolvedValue(null)
    workspaceStoreMocks.workspacePath = ''
    backendMocks.createSessionShell.mockResolvedValue({ sessionId: 'sess-1' })
    backendMocks.insertOutgoingMessage.mockResolvedValue({})
    backendMocks.listActorDirectoryByIds.mockResolvedValue([])
    backendMocks.listDaemonWorkspaces.mockResolvedValue([])
    backendMocks.fetchLatestRuntimeForSession.mockResolvedValue(null)
  })

  function mockTables(opts: {
    runtimes?: Array<{ agent_id: string; workspace_id: string | null; backend_type: string | null }>
    sessionRuntimes?: Array<{ agent_id: string; workspace_id: string | null }>
    actors?: Array<{ id: string; agent_types: string[]; default_agent_type: string | null; default_workspace_id?: string | null }>
    workspaces?: Array<{ id: string; agent_id: string | null; archived?: boolean }>
  }) {
    backendMocks.listLatestAgentRuntimeHints.mockResolvedValue(
      (opts.runtimes ?? []).map((r) => ({
        id: `runtime-${r.agent_id}`,
        runtime_id: `runtime-id-${r.agent_id}`,
        session_id: 'previous-session',
        status: 'running',
        current_model: null,
        updated_at: '2026-05-18T00:00:00.000Z',
        ...r,
      })),
    )
    backendMocks.fetchLatestRuntimeForSession.mockImplementation(async (agentId: string) => {
      const row = (opts.sessionRuntimes ?? []).find((r) => r.agent_id === agentId)
      if (!row?.workspace_id) return null
      return {
        id: `session-runtime-${agentId}`,
        runtime_id: `runtime-id-${agentId}`,
        team_id: 'team-1',
        agent_id: agentId,
        session_id: 'sess-1',
        workspace_id: row.workspace_id,
        backend_type: 'claude',
        backend_session_id: null,
        status: 'running',
        current_model: null,
        last_seen_at: null,
        created_at: '2026-05-18T00:00:00.000Z',
        updated_at: '2026-05-18T00:00:00.000Z',
      }
    })
    backendMocks.listAgentDefaults.mockResolvedValue(opts.actors ?? [])
    backendMocks.listActorDirectoryByIds.mockResolvedValue(
      (opts.actors ?? []).map((a) => ({
        id: a.id,
        team_id: 'team-1',
        actor_type: 'agent',
        display_name: a.id,
        default_workspace_id: a.default_workspace_id ?? null,
        agent_types: a.agent_types,
        default_agent_type: a.default_agent_type,
      })),
    )
    backendMocks.listDaemonWorkspaces.mockResolvedValue(
      (opts.workspaces ?? []).map((w) => ({
        id: w.id,
        team_id: 'team-1',
        agent_id: w.agent_id,
        created_by_member_id: null,
        name: w.id,
        path: null,
        archived: w.archived ?? false,
        created_at: '2026-05-18T00:00:00.000Z',
        updated_at: '2026-05-18T00:00:00.000Z',
      })),
    )
  }

  it('returns the backend session id after creating a shell', async () => {
    backendMocks.createSessionShell.mockResolvedValueOnce({ sessionId: 'pb_session_1' })

    const { createSessionShell } = await import('../session-create')
    const result = await createSessionShell({
      teamId: 'team-1',
      creatorActorId: 'member-1',
      title: 'hello',
      additionalActorIds: ['agent-1'],
    })

    expect(result.sessionId).toBe('pb_session_1')
    expect(backendMocks.createSessionShell).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1',
      createdByActorId: 'member-1',
      additionalActorIds: ['agent-1'],
    }))
  })

  it('sends opencode runtimeStart requests for this-session runtime workspace', async () => {
    mockTables({
      runtimes: [{ agent_id: 'agent-1', workspace_id: 'ws-other-session', backend_type: 'opencode' }],
      sessionRuntimes: [{ agent_id: 'agent-1', workspace_id: 'ws-opencode' }],
      actors: [{ id: 'agent-1', agent_types: [], default_agent_type: null }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-1',
        workspaceId: 'ws-opencode',
        worktree: '',
        agentType: AgentType.OPENCODE,
      }),
    )
  })

  it('falls back to claude runtimeStart requests without runtime history', async () => {
    mockTables({
      runtimes: [],
      actors: [{ id: 'agent-2', agent_types: [], default_agent_type: null }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-2'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-2',
        workspaceId: '',
        worktree: '',
        agentType: AgentType.CLAUDE_CODE,
      }),
    )
  })

  it('uses the first supported agent type without runtime history', async () => {
    mockTables({
      runtimes: [],
      actors: [{ id: 'agent-daemon', agent_types: ['opencode', 'claude'], default_agent_type: null }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-daemon'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-daemon',
        workspaceId: '',
        worktree: '',
        agentType: AgentType.OPENCODE,
      }),
    )
  })

  it('prefers actor.default_agent_type over prior runtime backend_type', async () => {
    // Prior runtime was opencode, but the operator has since set the agent's
    // default_agent_type to codex — the next spawn should respect that.
    mockTables({
      runtimes: [{ agent_id: 'agent-3', workspace_id: 'ws-old', backend_type: 'opencode' }],
      actors: [{ id: 'agent-3', agent_types: ['claude', 'codex'], default_agent_type: 'codex' }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-3'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-3',
        agentType: AgentType.CODEX,
      }),
    )
  })

  it('passes the selected model to runtimeStart', async () => {
    mockTables({
      runtimes: [{ agent_id: 'agent-4', workspace_id: 'ws-model', backend_type: 'claude' }],
      actors: [{ id: 'agent-4', agent_types: [], default_agent_type: null }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-4'],
      modelId: 'claude-opus-4-7',
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-4',
        modelId: 'claude-opus-4-7',
      }),
    )
  })

  it('applies the selected model after runtimeStart accepts the runtime', async () => {
    mockTables({
      runtimes: [{ agent_id: 'agent-6', workspace_id: 'ws-model', backend_type: 'opencode' }],
      actors: [{ id: 'agent-6', agent_types: [], default_agent_type: null }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-6'],
      modelId: 'opencode/deepseek-v4-flash-free',
    })

    expect(mockSetModel).toHaveBeenCalledWith({
      targetActorId: 'agent-6',
      runtimeId: 'rt-1',
      modelId: 'opencode/deepseek-v4-flash-free',
      timeoutMs: 20_000,
    })
  })

  it('uses the selected backend instead of prior runtime backend_type', async () => {
    mockTables({
      runtimes: [{ agent_id: 'agent-5', workspace_id: 'ws-backend', backend_type: 'opencode' }],
      actors: [{ id: 'agent-5', agent_types: [], default_agent_type: null }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-5'],
      agentType: AgentType.CLAUDE_CODE,
      modelId: 'claude-sonnet-4-6',
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-5',
        agentType: AgentType.CLAUDE_CODE,
        modelId: 'claude-sonnet-4-6',
      }),
    )
  })

  it('creates a cloud workspace when runtime lookup fails but local path is known', async () => {
    daemonAdminMocks.getLocalDaemonActorId.mockResolvedValue('agent-7')
    backendMocks.listLatestAgentRuntimeHints.mockRejectedValue(new Error('runtime hints unavailable'))
    backendMocks.listAgentDefaults.mockResolvedValue([
      { id: 'agent-7', agent_types: [], default_agent_type: null },
    ])
    workspaceStoreMocks.workspacePath = '/Users/me/TeamClaw'
    backendMocks.createDaemonWorkspace.mockResolvedValue({
      id: 'ws-created',
      team_id: 'team-1',
      agent_id: 'agent-7',
      name: 'TeamClaw',
      path: '/Users/me/TeamClaw',
      archived: false,
      created_at: '',
      updated_at: '',
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-7'],
    })

    expect(backendMocks.createDaemonWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 'team-1',
        agentId: 'agent-7',
        path: '/Users/me/TeamClaw',
      }),
    )
    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-7',
        workspaceId: 'ws-created',
        agentType: AgentType.CLAUDE_CODE,
      }),
    )
  })

  it('uses session runtime workspace and ignores team-wide prior workspace hint', async () => {
    backendMocks.listLatestAgentRuntimeHints.mockResolvedValue([
      {
        id: 'runtime-agent-8',
        agent_id: 'agent-8',
        workspace_id: 'ws-other-session',
        backend_type: 'opencode',
        runtime_id: 'runtime-id-agent-8',
        session_id: 'previous-session',
        status: 'running',
        current_model: null,
        updated_at: '2026-05-18T00:00:00.000Z',
      },
    ])
    backendMocks.fetchLatestRuntimeForSession.mockResolvedValue({
      id: 'session-runtime-agent-8',
      runtime_id: 'runtime-id-agent-8',
      team_id: 'team-1',
      agent_id: 'agent-8',
      session_id: 'sess-1',
      workspace_id: 'ws-this-session',
      backend_type: 'opencode',
      backend_session_id: null,
      status: 'running',
      current_model: null,
      last_seen_at: null,
      created_at: '2026-05-18T00:00:00.000Z',
      updated_at: '2026-05-18T00:00:00.000Z',
    })
    backendMocks.listAgentDefaults.mockRejectedValue(new Error('agent defaults unavailable'))
    backendMocks.listActorDirectoryByIds.mockResolvedValue([])
    backendMocks.listDaemonWorkspaces.mockResolvedValue([])

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-8'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-8',
        workspaceId: 'ws-this-session',
        worktree: '',
        agentType: AgentType.OPENCODE,
      }),
    )
  })

  it('uses the selected local workspace path for the local daemon agent', async () => {
    daemonAdminMocks.getLocalDaemonActorId.mockResolvedValue('agent-local')
    workspaceStoreMocks.workspacePath = '/Users/me/copilot-ws-v2'
    mockTables({
      runtimes: [],
      actors: [
        {
          id: 'agent-local',
          agent_types: [],
          default_agent_type: null,
          default_workspace_id: 'ws-accounting',
        },
      ],
      workspaces: [
        { id: 'ws-accounting', agent_id: 'agent-local' },
        { id: 'ws-copilot', agent_id: 'agent-local' },
      ],
    })
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-accounting',
        team_id: 'team-1',
        agent_id: 'agent-local',
        created_by_member_id: null,
        name: 'accounting-scripts',
        path: '/Users/me/accounting-scripts',
        archived: false,
        created_at: '2026-05-18T00:00:00.000Z',
        updated_at: '2026-05-18T00:00:00.000Z',
      },
      {
        id: 'ws-copilot',
        team_id: 'team-1',
        agent_id: 'agent-local',
        created_by_member_id: null,
        name: 'copilot-ws-v2',
        path: '/Users/me/copilot-ws-v2',
        archived: false,
        created_at: '2026-05-18T00:00:00.000Z',
        updated_at: '2026-05-18T00:00:00.000Z',
      },
    ])

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-new',
      teamId: 'team-1',
      agentActorIds: ['agent-local'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-local',
        workspaceId: 'ws-copilot',
        worktree: '',
      }),
    )
  })

  it('uses agent default_workspace_id when runtime history is empty', async () => {
    mockTables({
      runtimes: [],
      actors: [{ id: 'agent-9', agent_types: [], default_agent_type: null, default_workspace_id: 'ws-default' }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-9'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-9',
        workspaceId: 'ws-default',
        worktree: '',
      }),
    )
  })

  it('prefers workspaceIdHint from send/outbox over backend lookups', async () => {
    mockTables({
      runtimes: [],
      sessionRuntimes: [{ agent_id: 'agent-10', workspace_id: 'ws-session' }],
      actors: [{ id: 'agent-10', agent_types: [], default_agent_type: null, default_workspace_id: 'ws-default' }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-10'],
      workspaceIdHint: 'ws-from-send',
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-10',
        workspaceId: 'ws-from-send',
        worktree: '',
      }),
    )
  })

  it('sends the cloud workspace UUID straight to runtimeStart for the local daemon agent', async () => {
    daemonAdminMocks.getLocalDaemonActorId.mockResolvedValue('agent-12')
    mockTables({
      runtimes: [],
      sessionRuntimes: [{ agent_id: 'agent-12', workspace_id: 'cloud-ws-1' }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-12'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-12',
        workspaceId: 'cloud-ws-1',
        worktree: '',
      }),
    )
  })

  it('sends the cloud workspace id for remote agents without any daemon pre-registration', async () => {
    daemonAdminMocks.getLocalDaemonActorId.mockResolvedValue('local-agent')
    mockTables({
      runtimes: [],
      actors: [
        {
          id: 'remote-agent',
          agent_types: ['opencode'],
          default_agent_type: 'opencode',
          default_workspace_id: 'ws-remote',
        },
      ],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['remote-agent'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'remote-agent',
        workspaceId: 'ws-remote',
        worktree: '',
      }),
    )
  })

  it('returns failures when runtimeStart is rejected', async () => {
    mockTables({
      runtimes: [],
      actors: [{ id: 'remote-agent', agent_types: ['opencode'], default_agent_type: 'opencode' }],
    })
    mockRuntimeStart.mockResolvedValueOnce({
      accepted: false,
      runtimeId: '',
      sessionId: 'sess-1',
      rejectedReason: 'daemon busy',
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    const { failures } = await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['remote-agent'],
    })

    expect(failures).toEqual([
      { agentActorId: 'remote-agent', code: 'runtime_rejected', reason: 'daemon busy' },
    ])
  })

  it('returns failures when runtimeStart throws (e.g. RPC timeout)', async () => {
    mockTables({
      runtimes: [],
      actors: [{ id: 'remote-agent', agent_types: ['opencode'], default_agent_type: 'opencode' }],
    })
    mockRuntimeStart.mockRejectedValueOnce(new Error('RPC timeout'))

    const { startAgentRuntimesAsync } = await import('../session-create')
    const { failures } = await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['remote-agent'],
    })

    expect(failures).toEqual([
      { agentActorId: 'remote-agent', code: 'runtime_rpc_failed', reason: 'RPC timeout' },
    ])
  })

  it('returns accepted runtime ids and can skip post-start setModel', async () => {
    mockTables({
      runtimes: [],
      actors: [{ id: 'remote-agent', agent_types: ['opencode'], default_agent_type: 'opencode' }],
    })
    mockRuntimeStart.mockResolvedValueOnce({
      accepted: true,
      runtimeId: 'spawn-abc',
      sessionId: 'sess-1',
      rejectedReason: '',
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    const { failures, runtimeIdsByAgent } = await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['remote-agent'],
      modelId: 'opencode/big-pickle',
      skipModelApply: true,
    })

    expect(failures).toEqual([])
    expect(runtimeIdsByAgent).toEqual({ 'remote-agent': 'spawn-abc' })
    expect(mockSetModel).not.toHaveBeenCalled()
  })
})
