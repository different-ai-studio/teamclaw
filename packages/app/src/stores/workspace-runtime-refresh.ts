import { create } from 'zustand'
import { toast } from 'sonner'
import { isTauri } from '@/lib/utils'
import {
  encodeWorkspaceId,
  getDaemonRuntime,
  reloadDaemonRuntime,
  type DaemonRuntimeRefresh,
  type DaemonRuntimeRefreshStatus,
} from '@/lib/daemon-local-client'

const POLL_CLEAN_MS = 12_000
const POLL_ACTIVE_MS = 4_000

export interface WorkspaceRuntimeRefreshState {
  workspacePath: string | null
  refresh: DaemonRuntimeRefresh | null
  isApplying: boolean
  applyError: string | null
  startPolling: (workspacePath: string) => void
  stopPolling: () => void
  refreshNow: (workspacePath?: string) => Promise<void>
  /** Optimistic pending state when local skill files change before daemon poll catches up. */
  noteLocalRefresh: (changeKinds?: string[]) => void
  applyChanges: () => Promise<void>
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let pollWorkspacePath: string | null = null

function pollIntervalFor(status: DaemonRuntimeRefreshStatus | null | undefined): number {
  if (status === 'pending' || status === 'applying' || status === 'failed') {
    return POLL_ACTIVE_MS
  }
  return POLL_CLEAN_MS
}

function schedulePoll(intervalMs: number) {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    const path = pollWorkspacePath
    if (path) void useWorkspaceRuntimeRefreshStore.getState().refreshNow(path)
  }, intervalMs)
}

export const useWorkspaceRuntimeRefreshStore = create<WorkspaceRuntimeRefreshState>((set, get) => ({
  workspacePath: null,
  refresh: null,
  isApplying: false,
  applyError: null,

  startPolling(workspacePath: string) {
    pollWorkspacePath = workspacePath
    set({ workspacePath, applyError: null })
    void get().refreshNow(workspacePath)
  },

  stopPolling() {
    pollWorkspacePath = null
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    set({
      workspacePath: null,
      refresh: null,
      isApplying: false,
      applyError: null,
    })
  },

  noteLocalRefresh(changeKinds: string[] = ['skills']) {
    const workspacePath = get().workspacePath ?? pollWorkspacePath
    set({
      workspacePath: workspacePath ?? null,
      refresh: {
        status: 'pending',
        change_kinds: changeKinds,
        recommended_action: 'apply_changes',
        auto_apply_blocked_by_active_runtime: false,
        last_detected_at: new Date().toISOString(),
        last_error: null,
      },
    })
    if (workspacePath) {
      schedulePoll(POLL_ACTIVE_MS)
    }
  },

  async refreshNow(workspacePathArg?: string) {
    const workspacePath = workspacePathArg ?? get().workspacePath
    if (!workspacePath || !isTauri()) return

    const status = await getDaemonRuntime(encodeWorkspaceId(workspacePath))
    if (!status) return

    set({
      workspacePath,
      refresh: status.refresh,
      isApplying: status.refresh.status === 'applying' || get().isApplying,
    })
    schedulePoll(pollIntervalFor(status.refresh.status))
  },

  async applyChanges() {
    const workspacePath = get().workspacePath
    if (!workspacePath || get().isApplying) return

    set({ isApplying: true, applyError: null })
    try {
      const outcome = await reloadDaemonRuntime(encodeWorkspaceId(workspacePath))
      await get().refreshNow(workspacePath)

      if (outcome === 'restart_required') {
        toast.info('Agent restart required', {
          description:
            'Configuration was applied. Start a new session or wait for active runtimes to reload.',
        })
      } else if (outcome === 'reload_required') {
        toast.success('Runtime reload queued', {
          description: 'OpenCode will pick up the pending workspace changes.',
        })
      } else if (outcome === 'applied_live') {
        toast.success('Changes applied', {
          description: 'The workspace runtime picked up the latest configuration.',
        })
      }

      const refresh = get().refresh
      if (refresh?.status === 'failed' && refresh.last_error) {
        set({ applyError: refresh.last_error })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ applyError: message })
      toast.error('Failed to apply runtime changes', { description: message })
    } finally {
      set({ isApplying: false })
      if (pollWorkspacePath) {
        void get().refreshNow(pollWorkspacePath)
      }
    }
  },
}))
