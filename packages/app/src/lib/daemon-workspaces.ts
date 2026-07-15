import { getBackend } from '@/lib/backend'
import { getCurrentDaemonAgent } from '@/lib/daemon-agent-admin'

export interface DaemonWorkspace {
  id: string
  teamId: string
  agentId: string | null
  createdByMemberId: string | null
  name: string
  path: string | null
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface DaemonAgent {
  id: string
  displayName: string
  agentTypes: string[]
  defaultAgentType: string | null
  defaultWorkspaceId: string | null
  status: string | null
  lastActiveAt: string | null
}

function normalizeAgentTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function mapWorkspace(row: any): DaemonWorkspace {
  return {
    id: row.id,
    teamId: row.team_id,
    agentId: row.agent_id ?? null,
    createdByMemberId: row.created_by_member_id ?? null,
    name: row.name,
    path: row.path ?? null,
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listDaemonAgents(teamId: string): Promise<DaemonAgent[]> {
  const connectedRows = await getBackend().actors.listConnectedAgents(teamId)

  const connectedIds = connectedRows
    .map((row) => row.agent_id ?? row.id)
    .filter((id: unknown): id is string => typeof id === 'string')

  if (connectedIds.length === 0) return []

  const data = (await getBackend().actors.listActorDirectory(teamId))
    .filter((row) => row.actor_type === 'agent' && connectedIds.includes(row.id))
    .sort((a, b) => (a.display_name || a.id).localeCompare(b.display_name || b.id))

  return data.map((row) => ({
    id: row.id,
    displayName: row.display_name || row.id,
    agentTypes: normalizeAgentTypes(row.agent_types),
    defaultAgentType: row.default_agent_type ?? null,
    defaultWorkspaceId: row.default_workspace_id ?? null,
    status: row.agent_status ?? null,
    lastActiveAt: row.last_active_at ?? null,
  }))
}

export async function getCurrentDaemonWorkspaceAgent(teamId: string): Promise<DaemonAgent | null> {
  const agent = await getCurrentDaemonAgent(teamId)
  if (!agent) return null
  return {
    id: agent.id,
    displayName: agent.displayName,
    agentTypes: agent.agentTypes,
    defaultAgentType: agent.defaultAgentType,
    defaultWorkspaceId: agent.defaultWorkspaceId,
    status: agent.status ?? null,
    lastActiveAt: agent.lastActiveAt,
  }
}

export async function listDaemonWorkspaces(teamId: string, agentId?: string | null): Promise<DaemonWorkspace[]> {
  const data = await getBackend().workspaces.listDaemonWorkspaces(teamId, agentId)
  return data.map(mapWorkspace)
}

export async function createDaemonWorkspace(input: {
  teamId: string
  agentId: string
  createdByMemberId: string | null
  name: string
  path: string
}): Promise<DaemonWorkspace> {
  const data = await getBackend().workspaces.createDaemonWorkspace(input)
  return mapWorkspace(data)
}

async function archiveSessionsForWorkspace(
  teamId: string,
  target: { workspaceId: string; path: string | null },
): Promise<void> {
  const { loadSessionIdsForWorkspace } = await import('@/lib/session-by-workspace')
  const sessionIds = await loadSessionIdsForWorkspace(teamId, {
    workspaceId: target.workspaceId,
    path: target.path ?? '',
  })
  if (sessionIds.size === 0) return

  const { useSessionListStore } = await import('@/stores/session-list-store')
  const archiveSession = useSessionListStore.getState().archiveSession
  await Promise.all([...sessionIds].map((sessionId) => archiveSession(sessionId)))
}

export async function updateDaemonWorkspace(input: {
  workspaceId: string
  name: string
  path: string
  archived: boolean
}): Promise<DaemonWorkspace> {
  const data = await getBackend().workspaces.updateDaemonWorkspace(input)
  const workspace = mapWorkspace(data)

  if (input.archived) {
    try {
      await archiveSessionsForWorkspace(workspace.teamId, {
        workspaceId: workspace.id,
        path: workspace.path ?? input.path ?? null,
      })
    } catch (err) {
      console.warn('[daemon-workspaces] failed to archive linked sessions:', err)
    }
  }

  return workspace
}

export async function setAgentDefaultWorkspace(agentId: string, workspaceId: string): Promise<void> {
  await getBackend().actors.updateAgentDefaults({
    agentId,
    defaultWorkspaceId: workspaceId,
  })
}
