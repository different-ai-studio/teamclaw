import { invoke } from '@tauri-apps/api/core'
import { initOpenCodeClient } from './sdk-client'
import { useSessionStore } from '@/stores/session'
import { busySessions } from '@/stores/session-internals'
import { useWorkspaceStore } from '@/stores/workspace'

export interface RestartResult {
  url: string
}

export type OpenCodeReloadReason =
  | 'skills-file-change'
  | 'skills-permission-change'
  | 'team-skills-sync'
  | 'manual'

export type OpenCodeReloadMode = 'immediate' | 'defer-if-busy'

export type OpenCodeRuntimeReloadEventDetail = {
  workspacePath: string
  reason: OpenCodeReloadReason
  url?: string
  error?: string
}

export type OpenCodeReloadRequestResult =
  | { status: 'restarted'; url: string }
  | { status: 'deferred'; workspacePath: string; reason: OpenCodeReloadReason }

export const OPENCODE_RUNTIME_RELOAD_DEFERRED_EVENT = 'opencode-runtime-reload-deferred'
export const OPENCODE_RUNTIME_RELOADED_EVENT = 'opencode-runtime-reloaded'
export const OPENCODE_RUNTIME_RELOAD_FAILED_EVENT = 'opencode-runtime-reload-failed'

const runtimeReloadsInFlight = new Map<string, Promise<RestartResult>>()
const pendingRuntimeReloads = new Map<string, { workspacePath: string; reason: OpenCodeReloadReason }>()
let pendingReloadUnsubscribe: (() => void) | null = null

type RuntimeBusySnapshot = {
  busy: boolean
  reasons: string[]
}

// Stop+start the OpenCode sidecar and restore the SDK client URL and ready flags.
// Provider state (including the team provider) is reconciled by the Rust
// `ensure_team_provider` step inside `start_opencode` itself, so callers don't
// need to re-apply team config here.
export async function restartOpencode(workspacePath: string): Promise<RestartResult> {
  const { setOpenCodeBootstrapped, setOpenCodeReady } = useWorkspaceStore.getState()
  console.info('[OpenCodeReload] restarting OpenCode runtime', { workspacePath })
  setOpenCodeBootstrapped(false)
  await invoke('stop_opencode', { workspacePath })
  await new Promise((resolve) => setTimeout(resolve, 500))
  const status = await invoke<{ url: string }>('start_opencode', {
    config: { workspace_path: workspacePath },
  })
  initOpenCodeClient({ baseUrl: status.url, workspacePath })
  setOpenCodeBootstrapped(true, status.url)
  setOpenCodeReady(true, status.url)
  console.info('[OpenCodeReload] OpenCode runtime restarted', { workspacePath, url: status.url })
  return { url: status.url }
}

function emitRuntimeReloadEvent(eventName: string, detail: OpenCodeRuntimeReloadEventDetail) {
  if (
    typeof window === 'undefined' ||
    typeof window.dispatchEvent !== 'function' ||
    typeof window.CustomEvent !== 'function'
  ) {
    return
  }

  window.dispatchEvent(new window.CustomEvent(eventName, { detail }))
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getRuntimeBusySnapshot(): RuntimeBusySnapshot {
  const state = useSessionStore.getState()
  const reasons: string[] = []
  const activeStatuses = Object.values(state.sessionStatuses ?? {}).filter(
    (status) => status?.type === 'busy' || status?.type === 'retry',
  )

  if (activeStatuses.length > 0) {
    reasons.push(`session-status:${activeStatuses.map((status) => status?.type).join(',')}`)
  }
  if (busySessions.size > 0) {
    reasons.push(`busy-sessions:${busySessions.size}`)
  }
  if ((state.pendingPermissions?.length ?? 0) > 0) {
    reasons.push(`pending-permissions:${state.pendingPermissions.length}`)
  }
  if ((state.pendingQuestions?.length ?? 0) > 0) {
    reasons.push(`pending-questions:${state.pendingQuestions.length}`)
  }

  return { busy: reasons.length > 0, reasons }
}

async function performRuntimeReload(
  workspacePath: string,
  reason: OpenCodeReloadReason,
): Promise<RestartResult> {
  const existingReload = runtimeReloadsInFlight.get(workspacePath)
  if (existingReload) {
    console.info('[OpenCodeReload] joining in-flight reload', { workspacePath, reason })
    return existingReload
  }

  console.info('[OpenCodeReload] starting reload', { workspacePath, reason })
  const reload = restartOpencode(workspacePath)
    .then((result) => {
      console.info('[OpenCodeReload] reload completed', { workspacePath, reason, url: result.url })
      emitRuntimeReloadEvent(OPENCODE_RUNTIME_RELOADED_EVENT, {
        workspacePath,
        reason,
        url: result.url,
      })
      return result
    })
    .catch((error) => {
      console.error('[OpenCodeReload] reload failed', {
        workspacePath,
        reason,
        error: getErrorMessage(error),
      })
      emitRuntimeReloadEvent(OPENCODE_RUNTIME_RELOAD_FAILED_EVENT, {
        workspacePath,
        reason,
        error: getErrorMessage(error),
      })
      throw error
    })
    .finally(() => {
      if (runtimeReloadsInFlight.get(workspacePath) === reload) {
        runtimeReloadsInFlight.delete(workspacePath)
      }
    })

  runtimeReloadsInFlight.set(workspacePath, reload)
  return reload
}

function flushPendingRuntimeReloads() {
  if (pendingRuntimeReloads.size === 0) {
    clearPendingReloadSubscription()
    return
  }

  const busySnapshot = getRuntimeBusySnapshot()
  if (busySnapshot.busy) {
    console.info('[OpenCodeReload] pending reload still deferred because runtime is busy', {
      pendingWorkspaces: Array.from(pendingRuntimeReloads.keys()),
      reasons: busySnapshot.reasons,
    })
    return
  }

  for (const [workspacePath, pendingReload] of pendingRuntimeReloads) {
    if (runtimeReloadsInFlight.has(workspacePath)) {
      continue
    }

    pendingRuntimeReloads.delete(workspacePath)
    console.info('[OpenCodeReload] flushing deferred reload', {
      workspacePath: pendingReload.workspacePath,
      reason: pendingReload.reason,
    })
    void performRuntimeReload(pendingReload.workspacePath, pendingReload.reason).catch(() => undefined)
  }

  if (pendingRuntimeReloads.size === 0) {
    clearPendingReloadSubscription()
  }
}

function clearPendingReloadSubscription() {
  pendingReloadUnsubscribe?.()
  pendingReloadUnsubscribe = null
}

function ensurePendingReloadSubscription() {
  if (pendingReloadUnsubscribe) {
    return
  }

  pendingReloadUnsubscribe = useSessionStore.subscribe(() => {
    flushPendingRuntimeReloads()
  })
}

export function requestOpenCodeRuntimeReload(
  workspacePath: string,
  reason: OpenCodeReloadReason = 'manual',
  options: { mode?: OpenCodeReloadMode } = {},
): Promise<OpenCodeReloadRequestResult> {
  const existingReload = runtimeReloadsInFlight.get(workspacePath)
  if (existingReload) {
    console.info('[OpenCodeReload] request joined existing reload', { workspacePath, reason })
    return existingReload.then((result) => ({ status: 'restarted', url: result.url }))
  }

  const busySnapshot = getRuntimeBusySnapshot()
  if (options.mode === 'defer-if-busy' && busySnapshot.busy) {
    pendingRuntimeReloads.set(workspacePath, { workspacePath, reason })
    ensurePendingReloadSubscription()
    console.info('[OpenCodeReload] reload deferred because runtime is busy', {
      workspacePath,
      reason,
      reasons: busySnapshot.reasons,
    })
    emitRuntimeReloadEvent(OPENCODE_RUNTIME_RELOAD_DEFERRED_EVENT, {
      workspacePath,
      reason,
    })

    return Promise.resolve({ status: 'deferred', workspacePath, reason })
  }

  pendingRuntimeReloads.delete(workspacePath)
  if (pendingRuntimeReloads.size === 0) {
    clearPendingReloadSubscription()
  }
  console.info('[OpenCodeReload] reload requested immediately', { workspacePath, reason, mode: options.mode ?? 'immediate' })
  return performRuntimeReload(workspacePath, reason).then((result) => ({
    status: 'restarted',
    url: result.url,
  }))
}
