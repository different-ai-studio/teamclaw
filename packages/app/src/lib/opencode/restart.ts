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

// Stop+start the OpenCode sidecar and restore the SDK client URL and ready flags.
// Provider state (including the team provider) is reconciled by the Rust
// `ensure_team_provider` step inside `start_opencode` itself, so callers don't
// need to re-apply team config here.
export async function restartOpencode(workspacePath: string): Promise<RestartResult> {
  const { setOpenCodeBootstrapped, setOpenCodeReady } = useWorkspaceStore.getState()
  setOpenCodeBootstrapped(false)
  await invoke('stop_opencode', { workspacePath })
  await new Promise((resolve) => setTimeout(resolve, 500))
  const status = await invoke<{ url: string }>('start_opencode', {
    config: { workspace_path: workspacePath },
  })
  initOpenCodeClient({ baseUrl: status.url, workspacePath })
  setOpenCodeBootstrapped(true, status.url)
  setOpenCodeReady(true, status.url)
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

function isRuntimeBusy(): boolean {
  const state = useSessionStore.getState()
  const hasBusyStatus = Object.values(state.sessionStatuses ?? {}).some(
    (status) => status?.type === 'busy' || status?.type === 'retry',
  )

  return (
    hasBusyStatus ||
    busySessions.size > 0 ||
    (state.pendingPermissions?.length ?? 0) > 0 ||
    (state.pendingQuestions?.length ?? 0) > 0
  )
}

async function performRuntimeReload(
  workspacePath: string,
  reason: OpenCodeReloadReason,
): Promise<RestartResult> {
  const existingReload = runtimeReloadsInFlight.get(workspacePath)
  if (existingReload) {
    return existingReload
  }

  const reload = restartOpencode(workspacePath)
    .then((result) => {
      emitRuntimeReloadEvent(OPENCODE_RUNTIME_RELOADED_EVENT, {
        workspacePath,
        reason,
        url: result.url,
      })
      return result
    })
    .catch((error) => {
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

  if (isRuntimeBusy()) {
    return
  }

  for (const [workspacePath, pendingReload] of pendingRuntimeReloads) {
    if (runtimeReloadsInFlight.has(workspacePath)) {
      continue
    }

    pendingRuntimeReloads.delete(workspacePath)
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
    return existingReload.then((result) => ({ status: 'restarted', url: result.url }))
  }

  if (options.mode === 'defer-if-busy' && isRuntimeBusy()) {
    pendingRuntimeReloads.set(workspacePath, { workspacePath, reason })
    ensurePendingReloadSubscription()
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
  return performRuntimeReload(workspacePath, reason).then((result) => ({
    status: 'restarted',
    url: result.url,
  }))
}
