import { getBackend } from '@/lib/backend'
import { workspacePathsMatch } from '@/stores/session-utils'

/** Inputs for picking the cloud workspace id sent in runtimeStart. */
export type AgentWorkspaceLookup = {
  /** Explicit hint from send/outbox — highest priority. */
  callerWorkspaceId?: string | null
  /** Latest `agent_runtimes.workspace_id` for this agent *in this session*. */
  sessionWorkspaceId?: string | null
  /** `agents.default_workspace_id` from actor directory. */
  defaultWorkspaceId?: string | null
  /** First non-archived `workspaces` row bound to this agent. */
  ownedWorkspaceId?: string | null
}

/**
 * Cloud workspace UUID to pass in `runtimeStart.workspaceId`.
 * Never returns a local filesystem path — the target daemon resolves `path`
 * from its own `workspaces.toml` via `remote_workspace_id`.
 *
 * Priority: caller hint (send/outbox) → this session's prior runtime → agent
 * default → agent-owned workspace. Team-wide cross-session hints are
 * intentionally excluded so a runtime in workspace A from another conversation
 * cannot leak into session B.
 */
export function resolveAgentRuntimeWorkspaceId(lookup: AgentWorkspaceLookup): string {
  for (const candidate of [
    lookup.callerWorkspaceId,
    lookup.sessionWorkspaceId,
    lookup.defaultWorkspaceId,
    lookup.ownedWorkspaceId,
  ]) {
    const trimmed = candidate?.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/** runtimeStart payload: workspace id only; path is resolved on the target daemon. */
export function runtimeStartWorkspaceArgs(workspaceId: string): {
  workspaceId: string
  worktree: string
} {
  return { workspaceId, worktree: '' }
}

/**
 * Batch-load workspace hints for a set of agents in one session. Safe to call
 * once per startAgentRuntimesAsync fanout.
 */
export async function loadAgentWorkspaceLookups(
  teamId: string,
  sessionId: string,
  agentActorIds: string[],
): Promise<Map<string, AgentWorkspaceLookup>> {
  const ids = [...new Set(agentActorIds.map((id) => id.trim()).filter(Boolean))]
  const out = new Map<string, AgentWorkspaceLookup>()
  if (ids.length === 0) return out

  const backend = getBackend()
  const [actorRows, workspaceRows] = await Promise.all([
    backend.actors.listActorDirectoryByIds(ids).catch(() => []),
    backend.workspaces.listDaemonWorkspaces(teamId).catch(() => []),
  ])

  for (const id of ids) {
    out.set(id, {})
  }

  if (sessionId.trim()) {
    await Promise.all(
      ids.map(async (agentId) => {
        try {
          const row = await backend.runtime.fetchLatestRuntimeForSession(agentId, sessionId)
          if (!row?.workspace_id?.trim()) return
          const existing = out.get(agentId)!
          existing.sessionWorkspaceId = row.workspace_id
        } catch {
          // 404 / offline — fall through to defaults.
        }
      }),
    )
  }

  for (const row of actorRows) {
    const agentId = row.id?.trim()
    if (!agentId || !out.has(agentId)) continue
    const existing = out.get(agentId)!
    if (!existing.defaultWorkspaceId && row.default_workspace_id?.trim()) {
      existing.defaultWorkspaceId = row.default_workspace_id
    }
  }

  for (const row of workspaceRows) {
    if (row.archived) continue
    const agentId = row.agent_id?.trim()
    if (!agentId || !out.has(agentId)) continue
    const existing = out.get(agentId)!
    if (!existing.ownedWorkspaceId && row.id?.trim()) {
      existing.ownedWorkspaceId = row.id
    }
  }

  return out
}

/**
 * Map the desktop user's local workspace folder to a cloud workspace UUID by
 * matching `workspaces.path` on the team.
 */
export async function resolveCloudWorkspaceIdForLocalPath(
  teamId: string,
  localWorkspacePath: string,
  opts?: { agentActorId?: string | null },
): Promise<string | null> {
  const trimmedTeam = teamId.trim()
  const trimmedPath = localWorkspacePath.trim()
  const agentFilter = opts?.agentActorId?.trim() || null
  if (!trimmedTeam || !trimmedPath) return null

  const rows = await getBackend().workspaces.listDaemonWorkspaces(trimmedTeam).catch(() => [])
  for (const row of rows) {
    if (row.archived) continue
    if (agentFilter && row.agent_id?.trim() !== agentFilter) continue
    const cloudId = row.id?.trim()
    const daemonPath = row.path?.trim()
    if (!cloudId || !daemonPath) continue
    if (workspacePathsMatch(trimmedPath, daemonPath)) return cloudId
  }
  return null
}

/** Prefer the sole cloud workspace row bound to an agent when path matching fails. */
export async function resolveCloudWorkspaceIdForAgents(
  teamId: string,
  agentActorIds: string[],
): Promise<string | null> {
  const trimmedTeam = teamId.trim()
  const ids = [...new Set(agentActorIds.map((id) => id.trim()).filter(Boolean))]
  if (!trimmedTeam || ids.length === 0) return null

  const rows = await getBackend().workspaces.listDaemonWorkspaces(trimmedTeam).catch(() => [])
  for (const agentId of ids) {
    const bound = rows.filter((row) => !row.archived && row.agent_id?.trim() === agentId)
    if (bound.length >= 1) {
      const cloudId = bound[0].id?.trim()
      if (cloudId) return cloudId
    }
  }
  return null
}

/**
 * Resolve or create the cloud workspace UUID for runtimeStart.workspaceId.
 * Never returns a filesystem path.
 */
export async function ensureCloudWorkspaceIdForAgentRuntime(args: {
  teamId: string
  agentActorId: string
  localWorkspacePath?: string | null
  sessionId?: string
  createdByMemberId?: string | null
}): Promise<string> {
  const agentActorId = args.agentActorId.trim()
  if (!agentActorId || !args.teamId.trim()) return ''

  const fromHint = await resolveSessionWorkspaceHintForRuntimeStart({
    teamId: args.teamId,
    localWorkspacePath: args.localWorkspacePath,
    sessionId: args.sessionId,
    agentActorIds: [agentActorId],
    localDaemonActorId: args.localWorkspacePath?.trim() ? agentActorId : null,
  })
  if (fromHint) return fromHint

  const path = args.localWorkspacePath?.trim()
  if (!path) return ''

  const name = path.split('/').filter(Boolean).pop() || 'workspace'
  try {
    const created = await getBackend().workspaces.createDaemonWorkspace({
      teamId: args.teamId,
      agentId: agentActorId,
      createdByMemberId: args.createdByMemberId ?? null,
      name,
      path,
    })
    return created.id?.trim() || ''
  } catch {
    return ''
  }
}

/**
 * Best-effort workspace hint for runtimeStart on the outbox/send path.
 * Prefer the current local workspace binding; fall back to per-session /
 * per-agent backend lookups when path matching fails.
 */
export async function resolveSessionWorkspaceHintForRuntimeStart(args: {
  teamId: string
  localWorkspacePath?: string | null
  sessionId?: string
  agentActorIds?: string[]
  /** When set, local-path matching only considers workspaces bound to this agent. */
  localDaemonActorId?: string | null
}): Promise<string> {
  const agentActorIds = [...new Set((args.agentActorIds ?? []).map((id) => id.trim()).filter(Boolean))]

  const localPath = args.localWorkspacePath?.trim()
  const localDaemonActorId = args.localDaemonActorId?.trim()
  if (localPath && localDaemonActorId) {
    const fromPath = await resolveCloudWorkspaceIdForLocalPath(args.teamId, localPath, {
      agentActorId: localDaemonActorId,
    })
    if (fromPath) return fromPath
  }

  const sessionId = args.sessionId?.trim() ?? ''
  if (sessionId && agentActorIds.length > 0) {
    const lookups = await loadAgentWorkspaceLookups(args.teamId, sessionId, agentActorIds).catch(
      () => new Map<string, AgentWorkspaceLookup>(),
    )
    for (const agentId of agentActorIds) {
      const resolved = resolveAgentRuntimeWorkspaceId(lookups.get(agentId) ?? {})
      if (resolved) return resolved
    }
  }

  if (agentActorIds.length > 0) {
    const fromAgentBinding = await resolveCloudWorkspaceIdForAgents(args.teamId, agentActorIds)
    if (fromAgentBinding) return fromAgentBinding
  }

  return ''
}
