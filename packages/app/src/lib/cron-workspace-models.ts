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
import { resolveAgentAvailableModels } from '@/lib/agent-available-models'
import { AgentType } from '@/lib/proto/amux_pb'
import { useRuntimeStateStore, type RuntimeStateEntry } from '@/stores/runtime-state-store'
import { workspacePathsMatch } from '@/stores/session-utils'
import type { CronScope } from '@/stores/cron'
import { isTauri } from '@/lib/utils'

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
    const rows = await invoke<LocalDaemonWorkspace[]>('list_local_daemon_workspaces')
    return dedupeWorkspacesByPath(rows)
  } catch {
    return []
  }
}

/** The daemon can register several workspace ids for the same on-disk path;
 *  collapse them to one entry per path (preferring the default row) so the cron
 *  workspace picker doesn't list the same path a dozen times. */
function dedupeWorkspacesByPath(rows: LocalDaemonWorkspace[]): LocalDaemonWorkspace[] {
  const byPath = new Map<string, LocalDaemonWorkspace>()
  for (const row of rows) {
    const key = row.path?.trim()
    if (!key) continue
    const existing = byPath.get(key)
    // Keep the first occurrence, but let a default row win over a non-default one.
    if (!existing || (row.isDefault && !existing.isDefault)) {
      byPath.set(key, row)
    }
  }
  return [...byPath.values()]
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

/** A single selectable model in the cron dialog, carrying its backend so the
 *  scheduler can pin the job to the right agent runtime. */
export interface CronModelOption {
  /** ACP model id (often `provider/model`) — stored verbatim as `payload.model`. */
  ref: string
  name: string
  /** Daemon-advertised provider label, used to group the picker like chat does. */
  providerName?: string
}

/** Models for one agent backend. Cron UI renders a flat list like chat. */
export interface CronModelGroup {
  /** "opencode" | "claude" | "codex" — stored as `payload.backend`. */
  backend: string
  label: string
  models: CronModelOption[]
}

export function cronBackendFromAgentType(agentType: AgentType): string {
  switch (agentType) {
    case AgentType.CLAUDE_CODE:
      return 'claude'
    case AgentType.CODEX:
      return 'codex'
    case AgentType.OPENCODE:
    default:
      return 'opencode'
  }
}

function uniqueRuntimeEntries(): RuntimeStateEntry[] {
  const seen = new Set<RuntimeStateEntry>()
  for (const entry of Object.values(useRuntimeStateStore.getState().byRuntimeId)) {
    seen.add(entry)
  }
  return [...seen]
}

/** Newest live runtime whose worktree matches the target workspace path. */
export function findRuntimeForWorkspace(workspacePath: string): RuntimeStateEntry | undefined {
  const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId
  let best: RuntimeStateEntry | undefined
  for (const entry of uniqueRuntimeEntries()) {
    const worktree = entry.info.worktree?.trim()
    if (!worktree || !workspacePathsMatch(workspacePath, worktree)) continue

    const agentKey = entry.daemonActorId.trim()
    const canonical = agentKey ? byRuntimeId[agentKey] : undefined
    if (canonical && canonical !== entry) continue

    if (!best || entry.lastUpdated > best.lastUpdated) best = entry
  }
  return best
}

function groupFromAcpModels(
  models: Array<{ id: string; displayName: string; providerName?: string }>,
  backend: string,
): CronModelGroup[] {
  if (models.length === 0) return []
  return [
    {
      backend,
      label: '',
      models: models.map((m) => ({
        ref: m.id,
        name: m.displayName?.trim() || m.id,
        providerName: m.providerName?.trim() || undefined,
      })),
    },
  ]
}

/** Same source as chat AgentSelectorDock: live ACP `available_models`. */
export function modelsFromLiveRuntime(workspacePath: string): CronModelGroup[] {
  const runtime = findRuntimeForWorkspace(workspacePath)
  if (!runtime) return []
  const models = resolveAgentAvailableModels(runtime.info)
  return groupFromAcpModels(models, cronBackendFromAgentType(runtime.info.agentType))
}

/** When no live runtime advertises models, fall back to the daemon catalog slice
 *  for the default (or preferred) backend — same ACP probe path runtime attach uses. */
export async function modelsFromCatalogFallback(
  workspacePath: string,
  preferBackend?: string | null,
): Promise<{
  groups: CronModelGroup[]
  automationDefaultBackend: string | null
} | null> {
  const catalog = await getDaemonModelCatalog(encodeWorkspaceId(workspacePath))
  if (catalog === null) return null

  const backendId = preferBackend ?? catalog.automation_default_backend ?? 'opencode'
  const slice = catalog.backends.find((b) => b.backend === backendId)
  if (!slice || slice.models.length === 0) {
    return { groups: [], automationDefaultBackend: catalog.automation_default_backend }
  }

  return {
    groups: [
      {
        backend: backendId,
        label: '',
        models: slice.models.map((m) => ({
          ref: m.ref,
          name: m.display_name,
        })),
      },
    ],
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

/** Resolve target workspace path for cron scope and load model options. */
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

  const liveGroups = modelsFromLiveRuntime(resolvedPath)
  if (liveGroups.length > 0) {
    return {
      groups: liveGroups,
      automationDefaultBackend: liveGroups[0]?.backend ?? null,
      hint: null,
    }
  }

  if (isTauri()) {
    const daemonReady = await waitForDaemonHttpReady()
    if (!daemonReady) {
      return { groups: [], automationDefaultBackend: null, hint: args.messages.daemonUnavailable }
    }
  }

  try {
    const runtime = findRuntimeForWorkspace(resolvedPath)
    const preferBackend = runtime
      ? cronBackendFromAgentType(runtime.info.agentType)
      : null
    const catalog = await modelsFromCatalogFallback(resolvedPath, preferBackend)
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
