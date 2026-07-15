import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendMocks = vi.hoisted(() => ({
  listDaemonWorkspaces: vi.fn().mockResolvedValue([]),
  createDaemonWorkspace: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    workspaces: {
      listDaemonWorkspaces: backendMocks.listDaemonWorkspaces,
      createDaemonWorkspace: backendMocks.createDaemonWorkspace,
    },
    runtime: {
      fetchLatestRuntimeForSession: vi.fn(),
    },
    actors: {
      listActorDirectoryByIds: vi.fn().mockResolvedValue([]),
    },
  }),
}))

import {
  resolveAgentRuntimeWorkspaceId,
  resolveCloudWorkspaceIdForLocalPath,
  resolveSessionWorkspaceHintForRuntimeStart,
  ensureCloudWorkspaceIdForAgentRuntime,
  runtimeStartWorkspaceArgs,
} from '../resolve-runtime-start-workspace'

describe('resolveAgentRuntimeWorkspaceId', () => {
  it('prefers caller hint over session runtime and defaults', () => {
    expect(
      resolveAgentRuntimeWorkspaceId({
        callerWorkspaceId: 'ws-caller',
        sessionWorkspaceId: 'ws-session',
        defaultWorkspaceId: 'ws-default',
        ownedWorkspaceId: 'ws-owned',
      }),
    ).toBe('ws-caller')
  })

  it('prefers this-session runtime workspace over defaults', () => {
    expect(
      resolveAgentRuntimeWorkspaceId({
        sessionWorkspaceId: 'ws-session',
        defaultWorkspaceId: 'ws-default',
        ownedWorkspaceId: 'ws-owned',
      }),
    ).toBe('ws-session')
  })

  it('falls back to default_workspace_id then agent-bound workspace', () => {
    expect(
      resolveAgentRuntimeWorkspaceId({
        defaultWorkspaceId: 'ws-default',
        ownedWorkspaceId: 'ws-owned',
      }),
    ).toBe('ws-default')

    expect(
      resolveAgentRuntimeWorkspaceId({
        ownedWorkspaceId: 'ws-owned',
      }),
    ).toBe('ws-owned')
  })

  it('returns empty when no cloud workspace is known', () => {
    expect(resolveAgentRuntimeWorkspaceId({})).toBe('')
  })
})

describe('runtimeStartWorkspaceArgs', () => {
  it('never sends caller worktree', () => {
    expect(runtimeStartWorkspaceArgs('uuid-ws')).toEqual({
      workspaceId: 'uuid-ws',
      worktree: '',
    })
  })
})

describe('resolveCloudWorkspaceIdForLocalPath', () => {
  beforeEach(() => {
    backendMocks.listDaemonWorkspaces.mockReset()
    backendMocks.listDaemonWorkspaces.mockResolvedValue([])
  })

  it('matches cloud workspace when API returns legacy slug field', async () => {
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-cloud',
        team_id: 'team-1',
        agent_id: 'agent-1',
        name: 'Main',
        path: '/Users/me/TeamClaw',
        archived: false,
        created_at: '',
        updated_at: '',
      },
    ])

    await expect(
      resolveCloudWorkspaceIdForLocalPath('team-1', '~/TeamClaw', { agentActorId: 'agent-1' }),
    ).resolves.toBe('ws-cloud')
  })

  it('ignores teammate workspaces that share the same folder name', async () => {
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-teammate',
        team_id: 'team-1',
        agent_id: 'agent-a',
        name: 'TeamClaw',
        path: '/Users/matt.chow/TeamClaw',
        archived: false,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'ws-local',
        team_id: 'team-1',
        agent_id: 'agent-b',
        name: 'TeamClaw',
        path: '/Users/me/TeamClaw',
        archived: false,
        created_at: '',
        updated_at: '',
      },
    ])

    await expect(
      resolveCloudWorkspaceIdForLocalPath('team-1', '~/TeamClaw', { agentActorId: 'agent-b' }),
    ).resolves.toBe('ws-local')
  })
})

describe('resolveSessionWorkspaceHintForRuntimeStart', () => {
  beforeEach(() => {
    backendMocks.listDaemonWorkspaces.mockReset()
    backendMocks.listDaemonWorkspaces.mockResolvedValue([])
  })

  it('prefers the current local workspace path over the first agent-bound workspace', async () => {
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-accounting',
        team_id: 'team-1',
        agent_id: 'agent-1',
        name: 'accounting-scripts',
        path: '/Users/me/accounting-scripts',
        archived: false,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'ws-copilot',
        team_id: 'team-1',
        agent_id: 'agent-1',
        name: 'copilot-ws-v2',
        path: '/Users/me/copilot-ws-v2',
        archived: false,
        created_at: '',
        updated_at: '',
      },
    ])

    await expect(
      resolveSessionWorkspaceHintForRuntimeStart({
        teamId: 'team-1',
        localWorkspacePath: '/Users/me/copilot-ws-v2',
        sessionId: 'sess-new',
        agentActorIds: ['agent-1'],
        localDaemonActorId: 'agent-1',
      }),
    ).resolves.toBe('ws-copilot')
  })
})

describe('ensureCloudWorkspaceIdForAgentRuntime', () => {
  beforeEach(() => {
    backendMocks.listDaemonWorkspaces.mockReset()
    backendMocks.createDaemonWorkspace.mockReset()
    backendMocks.listDaemonWorkspaces.mockResolvedValue([])
  })

  it('creates a cloud workspace when lookup and path match both fail', async () => {
    backendMocks.createDaemonWorkspace.mockResolvedValue({
      id: 'ws-new',
      team_id: 'team-1',
      agent_id: 'agent-1',
      name: 'TeamClaw',
      path: '/Users/me/TeamClaw',
      archived: false,
      created_at: '',
      updated_at: '',
    })

    await expect(
      ensureCloudWorkspaceIdForAgentRuntime({
        teamId: 'team-1',
        agentActorId: 'agent-1',
        localWorkspacePath: '/Users/me/TeamClaw',
        createdByMemberId: 'member-1',
      }),
    ).resolves.toBe('ws-new')

    expect(backendMocks.createDaemonWorkspace).toHaveBeenCalledWith({
      teamId: 'team-1',
      agentId: 'agent-1',
      createdByMemberId: 'member-1',
      name: 'TeamClaw',
      path: '/Users/me/TeamClaw',
    })
  })
})
