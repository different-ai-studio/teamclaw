import { getBackend } from '@/lib/backend'

export interface DaemonRuntime {
  id: string
  runtimeId: string | null
  teamId: string
  agentId: string
  agentName: string
  sessionId: string | null
  sessionTitle: string | null
  workspaceId: string | null
  workspaceName: string | null
  workspacePath: string | null
  backendType: string
  backendSessionId: string | null
  status: string
  currentModel: string | null
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}

type RuntimeRow = {
  id: string
  runtime_id: string | null
  team_id: string
  agent_id: string
  session_id: string | null
  workspace_id: string | null
  backend_type: string
  backend_session_id: string | null
  status: string
  current_model: string | null
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

export async function listDaemonRuntimes(teamId: string): Promise<DaemonRuntime[]> {
  const rows = await getBackend().runtime.listDaemonRuntimes(teamId) as RuntimeRow[]
  if (rows.length === 0) return []

  const agentIds = [...new Set(rows.map((row) => row.agent_id))]
  const sessionIds = [...new Set(rows.map((row) => row.session_id).filter((id): id is string => Boolean(id)))]
  const workspaceIds = [...new Set(rows.map((row) => row.workspace_id).filter((id): id is string => Boolean(id)))]

  const [agentRows, sessionRows, workspaceRows] = await Promise.all([
    getBackend().actors.listActorDirectoryByIds(agentIds),
    getBackend().sessions.listSessionDisplayRows(teamId, sessionIds),
    getBackend().workspaces.listWorkspacesByIds(teamId, workspaceIds),
  ])

  const agents = new Map(agentRows.map((row) => [row.id, row.display_name || row.id]))
  const sessions = new Map(sessionRows.map((row) => [row.id, row.title || row.id]))
  const workspaces = new Map(workspaceRows.map((row) => [row.id, {
    name: row.name || row.id,
    path: row.path ?? null,
  }]))

  return rows.map((row) => {
    const workspace = row.workspace_id ? workspaces.get(row.workspace_id) : null
    return {
      id: row.id,
      runtimeId: row.runtime_id ?? null,
      teamId: row.team_id,
      agentId: row.agent_id,
      agentName: agents.get(row.agent_id) ?? row.agent_id,
      sessionId: row.session_id ?? null,
      sessionTitle: row.session_id ? sessions.get(row.session_id) ?? row.session_id : null,
      workspaceId: row.workspace_id ?? null,
      workspaceName: workspace?.name ?? null,
      workspacePath: workspace?.path ?? null,
      backendType: row.backend_type,
      backendSessionId: row.backend_session_id ?? null,
      status: row.status,
      currentModel: row.current_model ?? null,
      lastSeenAt: row.last_seen_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  })
}
