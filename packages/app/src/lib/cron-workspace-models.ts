import { invoke } from '@tauri-apps/api/core'
import {
  getCurrentDaemonWorkspaceAgent,
  listDaemonWorkspaces,
} from '@/lib/daemon-workspaces'
import {
  isDaemonHttpAvailable,
  getDaemonModelCatalog,
  encodeWorkspaceId,
} from '@/lib/daemon-local-client'
import { TEAM_SHARED_PROVIDER_ID } from '@/lib/team-provider'
import { getBackend } from '@/lib/backend'
import { workspacePathsMatch } from '@/stores/session-utils'
import type { ConfiguredProvider } from '@/stores/provider'
import type { CronScope } from '@/stores/cron'
import { isTauri } from '@/lib/utils'

/** Backend a team-shared model runs on. Those are OpenCode-compatible provider
 *  models (sourced from the cloud team LLM config), so they execute on the
 *  OpenCode backend regardless of the daemon default. */
const TEAM_SHARED_BACKEND = 'opencode'

/** Map daemon HTTP workspace path to the canonical path registered on this daemon. */
export async function resolveDaemonWorkspacePath(
  teamId: string | null,
  localPath: string | null | undefined,
): Promise<string | null> {
  const trimmed = localPath?.trim()
  if (!trimmed) return null
  if (!teamId) return trimmed

  const rows = await listDaemonWorkspaces(teamId).catch(() => [])
  for (const row of rows) {
    const daemonPath = row.path?.trim()
    if (!daemonPath) continue
    if (workspacePathsMatch(trimmed, daemonPath)) return daemonPath
  }
  return trimmed
}

export interface LocalDaemonWorkspace {
  workspaceId: string
  remoteWorkspaceId: string
  path: string
  displayName: string
  teamId: string | null
  isDefault: boolean
}

export async function listLocalDaemonWorkspaces(): Promise<LocalDaemonWorkspace[]> {
  try {
    return await invoke<LocalDaemonWorkspace[]>('list_local_daemon_workspaces')
  } catch {
    return []
  }
}

export function defaultLocalDaemonWorkspacePath(rows: LocalDaemonWorkspace[]): string | null {
  const explicit = rows.find((row) => row.isDefault && row.path.trim())
  if (explicit) return explicit.path
  if (rows.length === 1 && rows[0].path.trim()) return rows[0].path
  return null
}

async function waitForDaemonHttpReady(timeoutMs = 8000): Promise<boolean> {
  if (!isTauri()) return false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isDaemonHttpAvailable()) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function loadTeamSharedProvider(teamId: string | null): Promise<ConfiguredProvider | null> {
  if (!teamId) return null
  // Cloud is the source of truth (`GET /v1/teams/:id/workspace-config` → `llm`).
  const llm = await getBackend().teamWorkspaceConfig.loadLlmConfig(teamId).catch(() => null)
  if (!llm?.enabled || !llm.baseUrl || llm.models.length === 0) return null
  return {
    id: TEAM_SHARED_PROVIDER_ID,
    name: 'Team Shared',
    models: llm.models.map((m) => ({ id: m.id, name: m.name })),
  }
}

/** A single selectable model in the cron dialog, carrying its backend so the
 *  scheduler can pin the job to the right agent runtime. */
export interface CronModelOption {
  /** `"<providerSegment>/<modelId>"` — stored verbatim as `payload.model`. */
  ref: string
  name: string
}

/** Models grouped by the agent backend that runs them. */
export interface CronModelGroup {
  /** "opencode" | "claude" | "codex" — stored as `payload.backend`. */
  backend: string
  label: string
  models: CronModelOption[]
}

/** Map the cloud team-shared LLM provider to its cron model group, if any. */
function teamSharedGroup(teamShared: ConfiguredProvider | null): CronModelGroup | null {
  if (!teamShared || teamShared.models.length === 0) return null
  return {
    backend: TEAM_SHARED_BACKEND,
    label: teamShared.name,
    models: teamShared.models.map((m) => ({
      ref: `${TEAM_SHARED_PROVIDER_ID}/${m.id}`,
      name: m.name,
    })),
  }
}

/** Fetch the daemon model catalog for a resolved workspace path and fold in the
 *  optional team-shared group. OpenCode models come from the same ACP probe as
 *  runtime attach (`configOptions[id=model]`). Returns `null` when unreachable. */
async function loadCatalogGroupsForPath(workspacePath: string, teamId: string | null): Promise<{
  groups: CronModelGroup[]
  automationDefaultBackend: string | null
} | null> {
  const catalog = await getDaemonModelCatalog(encodeWorkspaceId(workspacePath))
  if (catalog === null) return null

  const teamShared = await loadTeamSharedProvider(teamId)
  const sharedGroup = teamSharedGroup(teamShared)

  const catalogGroups: CronModelGroup[] = catalog.backends
    .map((b) => ({
      backend: b.backend,
      label: b.label,
      models: b.models.map((m) => ({ ref: m.ref, name: m.display_name })),
    }))
    .filter((g) => g.models.length > 0)

  const groups = sharedGroup ? [sharedGroup, ...catalogGroups] : catalogGroups
  return {
    groups,
    automationDefaultBackend: catalog.automation_default_backend,
  }
}

export type CronDialogModelLoadResult = {
  groups: CronModelGroup[]
  /** Backend the daemon picks when a job specifies none ("auto"); the dialog
   *  surfaces it as the default. `null` when no backend is configured. */
  automationDefaultBackend: string | null
  hint: string | null
}

/** Resolve target workspace path for cron scope and load provider/model options. */
export async function loadCronDialogModels(args: {
  activeScope: CronScope
  teamId: string | null
  /** Workspace-scoped cron only — explicit daemon workspace path, not the UI session workspace. */
  selectedWorkspacePath: string | null
  localWorkspaces?: LocalDaemonWorkspace[]
  messages: {
    workspaceNoPath: string
    globalNoTeam: string
    globalNoDefault: string
    globalNoDefaultPath: string
    daemonUnavailable: string
    noConfiguredModels: string
    loadFailed: string
  }
}): Promise<CronDialogModelLoadResult> {
  let targetPath: string | null = null
  let hint: string | null = null

  if (args.activeScope === 'workspace') {
    if (!args.selectedWorkspacePath) {
      hint = args.messages.workspaceNoPath
    } else {
      targetPath = args.selectedWorkspacePath
    }
  } else {
    const localWorkspaces = args.localWorkspaces ?? await listLocalDaemonWorkspaces()
    targetPath = defaultLocalDaemonWorkspacePath(localWorkspaces)
    if (!targetPath && args.teamId) {
      const agent = await getCurrentDaemonWorkspaceAgent(args.teamId).catch(() => null)
      const workspaces = agent ? await listDaemonWorkspaces(args.teamId, agent.id).catch(() => []) : []
      const defaultWs = workspaces.find((w) => w.id === agent?.defaultWorkspaceId)
      targetPath = defaultWs?.path || null

      if (targetPath) {
        const resolved = localWorkspaces.find((w) => workspacePathsMatch(w.path, targetPath!))
        targetPath = resolved?.path || targetPath
      }
    }
    if (!targetPath) {
      hint = args.messages.globalNoDefault
    }
  }

  if (!targetPath) {
    return { groups: [], automationDefaultBackend: null, hint }
  }

  const resolvedPath = await resolveDaemonWorkspacePath(args.teamId, targetPath)
  if (!resolvedPath) {
    return { groups: [], automationDefaultBackend: null, hint: args.messages.loadFailed }
  }

  if (isTauri()) {
    const daemonReady = await waitForDaemonHttpReady()
    if (!daemonReady) {
      return { groups: [], automationDefaultBackend: null, hint: args.messages.daemonUnavailable }
    }
  }

  try {
    const catalog = await loadCatalogGroupsForPath(resolvedPath, args.teamId)
    if (catalog === null) {
      return { groups: [], automationDefaultBackend: null, hint: args.messages.loadFailed }
    }

    if (catalog.groups.length === 0) {
      return {
        groups: [],
        automationDefaultBackend: catalog.automationDefaultBackend,
        hint: args.messages.noConfiguredModels,
      }
    }
    return {
      groups: catalog.groups,
      automationDefaultBackend: catalog.automationDefaultBackend,
      hint: null,
    }
  } catch {
    return { groups: [], automationDefaultBackend: null, hint: args.messages.loadFailed }
  }
}
