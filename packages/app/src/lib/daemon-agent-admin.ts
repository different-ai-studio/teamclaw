import * as React from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getBackend } from '@/lib/backend'

export type AgentPermissionLevel = 'view' | 'prompt' | 'admin'
export type AgentVisibility = 'personal' | 'team'

export interface CurrentDaemonAgent {
  id: string
  displayName: string
  visibility: AgentVisibility
  permissionLevel: AgentPermissionLevel | null
  isOwner: boolean
  status: string | null
  agentTypes: string[]
  defaultAgentType: string | null
  defaultWorkspaceId: string | null
  lastActiveAt: string | null
}

export interface AgentAccessRow {
  id: string
  agentId: string
  memberId: string
  memberName: string
  permissionLevel: AgentPermissionLevel
  grantedByMemberId: string | null
  createdAt: string
  updatedAt: string
}

export interface TeamMemberOption {
  id: string
  displayName: string
  role: string | null
}

function normalizeAgentTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * The local daemon's `actor_id`, read from its HTTP `GET /v1/info` endpoint
 * (`get_daemon_http_info` IPC → `{ base_url }`). This is the routing identity
 * the daemon persists in `~/.amuxd/backend.toml`. Returns `null` outside Tauri
 * or when the daemon is not running / not yet onboarded.
 *
 * NOTE: the legacy `get_device_info` Tauri command was deleted (device_id is
 * gone; the value was always actor_id), so this is the only frontend source
 * for the local routing identity.
 */
export async function getLocalDaemonActorId(): Promise<string | null> {
  const { isTauri } = await import('@/lib/utils')
  if (!isTauri()) return null
  try {
    const info = await invoke<{ base_url: string } | null>('get_daemon_http_info')
    if (!info?.base_url) return null
    const resp = await fetch(`${info.base_url}/v1/info`)
    if (!resp.ok) return null
    const body: { actor_id?: string } = await resp.json()
    const actorId = body.actor_id?.trim()
    return actorId || null
  } catch {
    return null
  }
}

let localActorIdPromise: Promise<string | null> | null = null

/**
 * React hook wrapping {@link getLocalDaemonActorId} with a module-level cache
 * so multiple mounted components (e.g. one AgentPill per @-mentioned agent)
 * share a single `/v1/info` fetch instead of one each.
 */
export function useLocalDaemonActorId(): string | null {
  const [actorId, setActorId] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!localActorIdPromise) localActorIdPromise = getLocalDaemonActorId()
    let cancelled = false
    void localActorIdPromise.then((id) => {
      if (!cancelled) setActorId(id)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return actorId
}

/**
 * The running daemon's own version string from `GET /v1/info` (`body.version`,
 * baked from amuxd's `CARGO_PKG_VERSION`). This is the *live* process version,
 * distinct from the bundled/installed version reported by `amuxd doctor`.
 * Returns null outside Tauri or when the daemon is unreachable.
 */
export async function getDaemonVersion(): Promise<string | null> {
  const { isTauri } = await import('@/lib/utils')
  if (!isTauri()) return null
  try {
    const info = await invoke<{ base_url: string } | null>('get_daemon_http_info')
    if (!info?.base_url) return null
    const resp = await fetch(`${info.base_url}/v1/info`)
    if (!resp.ok) return null
    const body: { version?: string } = await resp.json()
    const version = body.version?.trim()
    return version || null
  } catch {
    return null
  }
}

/** Returns the daemon's current MQTT connected state from `/v1/info`, or null if the daemon is unreachable. */
export async function getDaemonMqttConnected(): Promise<boolean | null> {
  const { isTauri } = await import('@/lib/utils')
  if (!isTauri()) return null
  try {
    const info = await invoke<{ base_url: string } | null>('get_daemon_http_info')
    if (!info?.base_url) return null
    const resp = await fetch(`${info.base_url}/v1/info`)
    if (!resp.ok) return null
    const body: { mqtt_connected?: boolean } = await resp.json()
    return body.mqtt_connected ?? null
  } catch {
    return null
  }
}

type ConnectedAgentListRow = {
  id?: string
  agent_id: string
  display_name: string | null
  agent_types: unknown
  default_agent_type: string | null
  permission_level: AgentPermissionLevel | null
  visibility: AgentVisibility
  is_owner: boolean
  last_active_at: string | null
}

async function mapConnectedAgentRow(
  teamId: string,
  row: ConnectedAgentListRow,
): Promise<CurrentDaemonAgent> {
  const backend = getBackend()
  const directoryRow = await backend.actors.getDaemonAgentDirectoryEntry(teamId, row.agent_id)

  return {
    id: row.agent_id,
    displayName: directoryRow?.display_name || row.display_name || row.agent_id,
    visibility: row.visibility,
    permissionLevel: row.permission_level,
    isOwner: row.is_owner,
    status: directoryRow?.agent_status ?? null,
    agentTypes: normalizeAgentTypes(directoryRow?.agent_types ?? row.agent_types),
    defaultAgentType: directoryRow?.default_agent_type ?? row.default_agent_type ?? null,
    defaultWorkspaceId: directoryRow?.default_workspace_id ?? null,
    lastActiveAt: directoryRow?.last_active_at ?? row.last_active_at ?? null,
  }
}

/**
 * Strict: only the agent whose id matches this machine's daemon actor_id.
 * Use for quick new chat, LocalDaemonRow, and daemon settings.
 */
export async function getLocalDaemonAgent(teamId: string): Promise<CurrentDaemonAgent | null> {
  const localActorId = await getLocalDaemonActorId()
  if (!localActorId) return null

  const rows = await getBackend().actors.listConnectedAgents(teamId) as ConnectedAgentListRow[]
  const row = rows.find((item) => item.agent_id === localActorId)
  if (!row) return null

  return mapConnectedAgentRow(teamId, row)
}

/**
 * Lenient: prefer the local daemon agent, else owner, else first connected row.
 * Use only where a best-effort agent pick is acceptable (e.g. session sheets).
 */
export async function getCurrentDaemonAgent(teamId: string): Promise<CurrentDaemonAgent | null> {
  const localActorId = await getLocalDaemonActorId()
  const rows = await getBackend().actors.listConnectedAgents(teamId) as ConnectedAgentListRow[]

  const row =
    rows.find((item) => localActorId && item.agent_id === localActorId) ??
    rows.find((item) => item.is_owner) ??
    rows[0]

  if (!row) return null
  return mapConnectedAgentRow(teamId, row)
}

export async function updateCurrentDaemonAgent(input: {
  agentId: string
  displayName: string
  visibility: AgentVisibility
}): Promise<void> {
  await getBackend().actors.updateOwnedAgentProfile({
    agentId: input.agentId,
    displayName: input.displayName,
    visibility: input.visibility,
  })
}

export async function setAgentDefaultType(agentId: string, defaultAgentType: string): Promise<void> {
  await getBackend().actors.updateAgentDefaults({
    agentId,
    defaultAgentType,
  })
}

export async function listAgentAccess(agentId: string): Promise<AgentAccessRow[]> {
  const rows = await getBackend().actors.listAgentAccess(agentId)
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    memberId: row.memberId,
    memberName: row.memberName,
    permissionLevel: row.permissionLevel,
    grantedByMemberId: row.grantedByMemberId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))
}

export async function listTeamMembersForAccess(teamId: string): Promise<TeamMemberOption[]> {
  return getBackend().actors.listTeamMembersForAccess(teamId)
}

export async function upsertAgentAccess(input: {
  agentId: string
  memberId: string
  permissionLevel: AgentPermissionLevel
  grantedByMemberId: string | null
}): Promise<void> {
  await getBackend().actors.upsertAgentAccess(input)
}

export async function removeAgentAccess(accessId: string): Promise<void> {
  await getBackend().actors.removeAgentAccess(accessId)
}
