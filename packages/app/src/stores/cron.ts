import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { withAsync } from '@/lib/store-utils'
import { getPreferredLanguage } from '@/lib/locale'
// ==================== Types ====================

export type ScheduleKind = 'at' | 'every' | 'cron'
export type CronScope = 'global' | 'workspace'

function cronInvokeArgs(scope: CronScope, selectedWorkspacePath: string | null) {
  return {
    scope,
    workspacePath: scope === 'workspace' ? selectedWorkspacePath : null,
  }
}

// "Run Now" watches for the cloud session id the daemon stamps onto this run's
// record, so the UI can jump straight to the session instead of blocking until
// the whole turn finishes. The scheduler creates the cloud session eagerly
// (via `cron-prepare-session`) and stamps `session_id` into the run record
// within a second or two of clicking — well before the ACP turn completes —
// so it surfaces in `cron_get_runs` almost immediately.
const RUN_JOB_SESSION_POLL_INTERVAL_MS = 1000
// Even with eager creation, a run whose prepare is queued behind another
// in-flight cron turn (the daemon serializes turns) can take longer. Keep the
// window well above the worst case so it still navigates instead of silently
// giving up.
const RUN_JOB_SESSION_MAX_POLL_MS = 5 * 60 * 1000

/**
 * Poll this job's run records until the run started by our `cron_run_job` call
 * (a run id not present in `knownRunIds`) has a `sessionId` stamped, and return
 * it. Returns null on timeout. The scheduler stamps `sessionId` early (eager
 * session prepare), so this usually resolves within a couple of polls.
 */
async function detectNewRunSession(
  jobId: string,
  scope: CronScope,
  selectedWorkspacePath: string | null,
  knownRunIds: Set<string>,
): Promise<string | null> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < RUN_JOB_SESSION_MAX_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, RUN_JOB_SESSION_POLL_INTERVAL_MS))
    let runs: CronRunRecord[]
    try {
      runs = await invoke<CronRunRecord[]>('cron_get_runs', {
        jobId,
        limit: 10,
        ...cronInvokeArgs(scope, selectedWorkspacePath),
      })
    } catch {
      continue // Transient failure — keep polling.
    }
    const fresh = runs.find((run) => !knownRunIds.has(run.runId) && !!run.sessionId)
    if (fresh?.sessionId) return fresh.sessionId
  }
  return null
}

export interface CronSchedule {
  kind: ScheduleKind
  at?: string // ISO 8601 for one-time
  everyMs?: number // Interval in milliseconds
  expr?: string // 5-field cron expression
  tz?: string // IANA timezone
}

export interface CronPayload {
  message: string
  model?: string // "provider/model"
  /** Backend the job runs on: "opencode" | "claude" | "codex". Absent/empty
   *  means "auto" — the daemon uses its default_agent_type. Pairs with `model`,
   *  whose `provider/model` ref is selected from this backend's catalog group. */
  backend?: string
  /** @deprecated Compatibility only. Runtime ignores this and new saves omit it. */
  timeoutSeconds?: number
  useWorktree?: boolean
  worktreeBranch?: string
}

export type DeliveryMode = 'announce' | 'none'
export type DeliveryChannel = 'discord' | 'feishu' | 'email' | 'kook' | 'wechat' | 'wecom'

export interface CronDelivery {
  mode: DeliveryMode
  channel: DeliveryChannel
  to: string
  bestEffort: boolean
}

export type RunStatus = 'success' | 'failed' | 'timeout' | 'running' | 'stale'

export interface CronJob {
  id: string
  name: string
  description?: string
  enabled: boolean
  schedule: CronSchedule
  payload: CronPayload
  delivery?: CronDelivery
  deleteAfterRun: boolean
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt?: string
}

export interface CronRunRecord {
  runId: string
  jobId: string
  startedAt: string
  finishedAt?: string
  status: RunStatus
  lastHeartbeatAt?: string
  sessionId?: string
  responseSummary?: string
  deliveryStatus?: string
  error?: string
  worktreePath?: string
}

export interface CreateCronJobRequest {
  name: string
  description?: string
  enabled: boolean
  schedule: CronSchedule
  payload: CronPayload
  delivery?: CronDelivery
  deleteAfterRun: boolean
}

export interface UpdateCronJobRequest {
  id: string
  name?: string
  description?: string
  enabled?: boolean
  schedule?: CronSchedule
  payload?: CronPayload
  delivery?: CronDelivery | null
  deleteAfterRun?: boolean
}

// ==================== Store ====================

interface CronState {
  jobs: CronJob[]
  isLoading: boolean
  error: string | null
  isInitialized: boolean
  activeScope: CronScope
  selectedWorkspacePath: string | null

  // All session IDs created by cron (for filtering in session list)
  cronSessionIds: Set<string>
  // Toggle to show only cron sessions in the session list
  showCronSessions: boolean

  // Run history for the currently viewed job
  selectedJobId: string | null
  runs: CronRunRecord[]
  runsLoading: boolean
  /** Job IDs currently executing via manual "Run Now". */
  runningJobIds: Set<string>

  // Actions
  init: () => Promise<void>
  reinit: () => Promise<void>
  setScope: (scope: CronScope) => Promise<void>
  setSelectedWorkspacePath: (workspacePath: string | null) => Promise<void>
  loadJobs: () => Promise<void>
  loadCronSessionIds: () => Promise<void>
  addJob: (request: CreateCronJobRequest) => Promise<CronJob>
  updateJob: (request: UpdateCronJobRequest) => Promise<CronJob>
  removeJob: (jobId: string) => Promise<void>
  toggleEnabled: (jobId: string, enabled: boolean) => Promise<void>
  runJob: (jobId: string) => Promise<void>
  loadRuns: (jobId: string, limit?: number) => Promise<void>
  refreshDelivery: () => Promise<void>
  clearError: () => void
  setSelectedJobId: (jobId: string | null) => void
  setShowCronSessions: (show: boolean) => void
  toggleShowCronSessions: () => void
}

export const useCronStore = create<CronState>((set, get) => ({
  jobs: [],
  isLoading: false,
  error: null,
  isInitialized: false,
  activeScope: 'global',
  selectedWorkspacePath: null,

  cronSessionIds: new Set<string>(),
  showCronSessions: false,

  selectedJobId: null,
  runs: [],
  runsLoading: false,
  runningJobIds: new Set<string>(),

  init: async () => {
    const alreadyInit = get().isInitialized
    if (alreadyInit) {
      console.log('[Cron] Already initialized, skipping')
      return
    }
    try {
      await invoke('cron_init', cronInvokeArgs(get().activeScope, get().selectedWorkspacePath))
      set({ isInitialized: true })
      await Promise.all([get().loadJobs(), get().loadCronSessionIds()])
    } catch (error) {
      console.error('[Cron] Init failed:', error)
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  reinit: async () => {
    try {
      set({ isInitialized: false })
      await invoke('cron_init', cronInvokeArgs(get().activeScope, get().selectedWorkspacePath))
      set({ isInitialized: true })
      await Promise.all([get().loadJobs(), get().loadCronSessionIds()])
    } catch (error) {
      console.error('[Cron] Re-init failed:', error)
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  setScope: async (scope: CronScope) => {
    set({
      activeScope: scope,
      isInitialized: false,
      jobs: [],
      error: null,
    })
    await get().reinit()
  },

  setSelectedWorkspacePath: async (workspacePath: string | null) => {
    if (workspacePath === get().selectedWorkspacePath) return
    set({
      selectedWorkspacePath: workspacePath,
      isInitialized: false,
      jobs: [],
      runs: [],
      selectedJobId: null,
      error: null,
    })
    await get().reinit()
  },

  loadJobs: async () => {
    if (!get().isInitialized) {
      await get().init()
      return
    }

    await withAsync(set, async () => {
      const jobs = await invoke<CronJob[]>(
        'cron_list_jobs',
        cronInvokeArgs(get().activeScope, get().selectedWorkspacePath),
      )
      set({ jobs })
    })
  },

  addJob: async (request: CreateCronJobRequest) => {
    const job = await withAsync(set, async () => {
      const job = await invoke<CronJob>('cron_add_job', {
        request,
        ...cronInvokeArgs(get().activeScope, get().selectedWorkspacePath),
      })
      set((state) => ({
        jobs: [...state.jobs, job],
      }))
      return job
    }, { rethrow: true })
    return job!
  },

  updateJob: async (request: UpdateCronJobRequest) => {
    const updated = await withAsync(set, async () => {
      const updated = await invoke<CronJob>('cron_update_job', {
        request,
        ...cronInvokeArgs(get().activeScope, get().selectedWorkspacePath),
      })
      set((state) => ({
        jobs: state.jobs.map((j) => (j.id === updated.id ? updated : j)),
      }))
      return updated
    }, { rethrow: true })
    return updated!
  },

  removeJob: async (jobId: string) => {
    await withAsync(set, async () => {
      await invoke('cron_remove_job', {
        jobId,
        ...cronInvokeArgs(get().activeScope, get().selectedWorkspacePath),
      })
      set((state) => ({
        jobs: state.jobs.filter((j) => j.id !== jobId),
        selectedJobId: state.selectedJobId === jobId ? null : state.selectedJobId,
      }))
    }, { rethrow: true })
  },

  toggleEnabled: async (jobId: string, enabled: boolean) => {
    try {
      await invoke('cron_toggle_enabled', {
        jobId,
        enabled,
        ...cronInvokeArgs(get().activeScope, get().selectedWorkspacePath),
      })
      set((state) => ({
        jobs: state.jobs.map((j) =>
          j.id === jobId ? { ...j, enabled } : j
        ),
      }))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  runJob: async (jobId: string) => {
    if (get().runningJobIds.has(jobId)) return

    const markRunning = () =>
      set((state) => ({
        runningJobIds: new Set([...state.runningJobIds, jobId]),
      }))
    const markIdle = () =>
      set((state) => {
        const runningJobIds = new Set(state.runningJobIds)
        runningJobIds.delete(jobId)
        return { runningJobIds }
      })

    markRunning()
    const { activeScope, selectedWorkspacePath } = get()

    // Snapshot the run ids that exist *before* this run so we can recognize the
    // one our cron_run_job creates (and read its stamped session id).
    let knownRunIds = new Set<string>()
    try {
      const priorRuns = await invoke<CronRunRecord[]>('cron_get_runs', {
        jobId,
        limit: 20,
        ...cronInvokeArgs(activeScope, selectedWorkspacePath),
      })
      knownRunIds = new Set(priorRuns.map((run) => run.runId))
    } catch {
      // No prior runs / transient failure — every run reads as new, which is fine.
    }

    try {
      await invoke('cron_run_job', {
        jobId,
        ...cronInvokeArgs(activeScope, selectedWorkspacePath),
      })

      const sessionId = await detectNewRunSession(
        jobId,
        activeScope,
        selectedWorkspacePath,
        knownRunIds,
      )
      void get().loadJobs()

      if (sessionId) {
        // Refresh the authoritative cron session ids first, then add this run's
        // session on top. The backend eagerly creates the session and stamps
        // session_id before the turn runs, but cron_get_all_session_ids can lag
        // that write by a beat, so without the optimistic add, turning the filter
        // on could momentarily hide this brand-new session. (Order matters:
        // loadCronSessionIds overwrites the set, so it must run before the add.)
        await get().loadCronSessionIds()
        set((state) => ({ cronSessionIds: new Set([...state.cronSessionIds, sessionId]) }))
        get().setShowCronSessions(true)
        // Close the settings pane, jump to the main chat view, and open the
        // session so the user watches it run live.
        const { useUIStore } = await import('@/stores/ui')
        await useUIStore.getState().switchToSession(sessionId)
      } else {
        void get().loadCronSessionIds()
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      markIdle()
    }
  },

  loadCronSessionIds: async () => {
    try {
      const ids = await invoke<string[]>(
        'cron_get_all_session_ids',
        cronInvokeArgs(get().activeScope, get().selectedWorkspacePath),
      )
      set({ cronSessionIds: new Set(ids) })
    } catch (error) {
      console.error('[Cron] Failed to load cron session IDs:', error)
    }
  },

  loadRuns: async (jobId: string, limit?: number) => {
    set({ runsLoading: true, selectedJobId: jobId })
    try {
      const runs = await invoke<CronRunRecord[]>('cron_get_runs', {
        jobId,
        limit: limit ?? 50,
        ...cronInvokeArgs(get().activeScope, get().selectedWorkspacePath),
      })
      set({ runs: runs.map(normalizeCronRunRecord), runsLoading: false })
    } catch (error) {
      console.error('[Cron] Failed to load runs:', error)
      set({ runs: [], runsLoading: false })
    }
  },

  refreshDelivery: async () => {
    try {
      await invoke('cron_refresh_delivery')
    } catch (error) {
      console.error('[Cron] Failed to refresh delivery:', error)
    }
  },

  clearError: () => set({ error: null }),
  setSelectedJobId: (jobId: string | null) => set({ selectedJobId: jobId }),
  setShowCronSessions: (show) => set({ showCronSessions: show }),
  toggleShowCronSessions: () => set(s => ({ showCronSessions: !s.showCronSessions })),
}))

// ==================== Helpers ====================

const LEGACY_TIMEOUT_CUT_SHORT_MARKER = 'AI response was cut short after'

export function normalizeCronRunRecord(record: CronRunRecord): CronRunRecord {
  const hasLegacyTimeoutText =
    record.responseSummary?.includes(LEGACY_TIMEOUT_CUT_SHORT_MARKER) ||
    record.error?.includes(LEGACY_TIMEOUT_CUT_SHORT_MARKER)

  if (record.status === 'success' && hasLegacyTimeoutText) {
    return { ...record, status: 'timeout' }
  }

  return record
}

/** Convert schedule to human-readable string */
export function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'at':
      if (schedule.at) {
        try {
          const date = new Date(schedule.at)
          return `One-time: ${date.toLocaleString()}`
        } catch {
          return `One-time: ${schedule.at}`
        }
      }
      return 'One-time'
    case 'every': {
      if (!schedule.everyMs) return 'Interval'
      const ms = schedule.everyMs
      if (ms < 60000) return `Every ${Math.round(ms / 1000)}s`
      if (ms < 3600000) return `Every ${Math.round(ms / 60000)} min`
      if (ms < 86400000) return `Every ${Math.round(ms / 3600000)}h`
      return `Every ${Math.round(ms / 86400000)} days`
    }
    case 'cron':
      return schedule.expr
        ? `Cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`
        : 'Cron'
    default:
      return 'Unknown'
  }
}

/** Format a relative time string with i18n support (e.g., "2 minutes ago" / "2分钟前") */
export function formatRelativeTime(dateStr: string): string {
  try {
    const lang = getPreferredLanguage()
    const date = new Date(dateStr)
    const now = new Date()
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000)

    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })

    // Future (e.g. next cron run): diffInSeconds is negative. Must not reuse the "past" branch,
    // or every future time would incorrectly show as "Just now" (negative < 60).
    if (diffInSeconds < 0) {
      const ahead = -diffInSeconds
      if (ahead < 60) {
        return rtf.format(1, 'minute')
      }
      if (ahead < 3600) {
        return rtf.format(Math.max(1, Math.round(ahead / 60)), 'minute')
      }
      if (ahead < 86400) {
        return rtf.format(Math.max(1, Math.round(ahead / 3600)), 'hour')
      }
      if (ahead < 2592000) {
        return rtf.format(Math.max(1, Math.round(ahead / 86400)), 'day')
      }
      if (ahead < 31536000) {
        return rtf.format(Math.max(1, Math.round(ahead / 2592000)), 'month')
      }
      return rtf.format(Math.max(1, Math.round(ahead / 31536000)), 'year')
    }

    // Past / now
    if (diffInSeconds < 60) {
      if (diffInSeconds <= 0) {
        return lang === 'zh' || lang === 'zh-CN' ? '刚刚' : 'Just now'
      }
      return rtf.format(-diffInSeconds, 'second')
    }
    if (diffInSeconds < 3600) {
      return rtf.format(-Math.floor(diffInSeconds / 60), 'minute')
    }
    if (diffInSeconds < 86400) {
      return rtf.format(-Math.floor(diffInSeconds / 3600), 'hour')
    }
    if (diffInSeconds < 2592000) {
      return rtf.format(-Math.floor(diffInSeconds / 86400), 'day')
    }
    if (diffInSeconds < 31536000) {
      return rtf.format(-Math.floor(diffInSeconds / 2592000), 'month')
    }
    return rtf.format(-Math.floor(diffInSeconds / 31536000), 'year')
  } catch {
    return dateStr
  }
}

/** Get run status color */
export function getRunStatusColor(status: RunStatus): string {
  switch (status) {
    case 'success':
      return 'text-green-500'
    case 'failed':
      return 'text-red-500'
    case 'timeout':
      return 'text-orange-500'
    case 'running':
      return 'text-blue-500'
    case 'stale':
      return 'text-yellow-500'
    default:
      return 'text-muted-foreground'
  }
}

/** Channel display name */
export function getChannelDisplayName(channel: DeliveryChannel): string {
  switch (channel) {
    case 'discord':
      return 'Discord'
    case 'feishu':
      return 'Feishu'
    case 'email':
      return 'Email'
    case 'kook':
      return 'KOOK'
    case 'wechat':
      return 'WeChat'
    default:
      return channel
  }
}
