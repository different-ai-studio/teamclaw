import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { withAsync } from '@/lib/store-utils'
import { appShortName } from '@/lib/build-config'

// ==================== Types ====================

export type ScheduleKind = 'at' | 'every' | 'cron'

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
  timeoutSeconds?: number // Max seconds for AI to respond (default: 180)
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

export type RunStatus = 'success' | 'failed' | 'timeout' | 'running'

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

  // All session IDs created by cron (for filtering in session list)
  cronSessionIds: Set<string>
  // Toggle to show only cron sessions in the session list
  showCronSessions: boolean

  // Run history for the currently viewed job
  selectedJobId: string | null
  runs: CronRunRecord[]
  runsLoading: boolean

  // Actions
  init: () => Promise<void>
  reinit: () => Promise<void>
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
  toggleShowCronSessions: () => void
}

export const useCronStore = create<CronState>((set, get) => ({
  jobs: [],
  isLoading: false,
  error: null,
  isInitialized: false,

  cronSessionIds: new Set<string>(),
  showCronSessions: false,

  selectedJobId: null,
  runs: [],
  runsLoading: false,

  init: async () => {
    const alreadyInit = get().isInitialized
    if (alreadyInit) {
      console.log('[Cron] Already initialized, skipping')
      return
    }
    try {
      await invoke('cron_init')
      set({ isInitialized: true })
      await Promise.all([get().loadJobs(), get().loadCronSessionIds()])
    } catch (error) {
      console.error('[Cron] Init failed:', error)
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  // Force re-initialization (used when workspace changes)
  reinit: async () => {
    try {
      set({ isInitialized: false })
      await invoke('cron_init')
      set({ isInitialized: true })
      await Promise.all([get().loadJobs(), get().loadCronSessionIds()])
    } catch (error) {
      console.error('[Cron] Re-init failed:', error)
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  loadJobs: async () => {
    await withAsync(set, async () => {
      const jobs = await invoke<CronJob[]>('cron_list_jobs')
      set({ jobs })
    })
  },

  addJob: async (request: CreateCronJobRequest) => {
    const job = await withAsync(set, async () => {
      const job = await invoke<CronJob>('cron_add_job', { request })
      set((state) => ({
        jobs: [...state.jobs, job],
      }))
      return job
    }, { rethrow: true })
    return job!
  },

  updateJob: async (request: UpdateCronJobRequest) => {
    const updated = await withAsync(set, async () => {
      const updated = await invoke<CronJob>('cron_update_job', { request })
      set((state) => ({
        jobs: state.jobs.map((j) => (j.id === updated.id ? updated : j)),
      }))
      return updated
    }, { rethrow: true })
    return updated!
  },

  removeJob: async (jobId: string) => {
    await withAsync(set, async () => {
      await invoke('cron_remove_job', { jobId })
      set((state) => ({
        jobs: state.jobs.filter((j) => j.id !== jobId),
        selectedJobId: state.selectedJobId === jobId ? null : state.selectedJobId,
      }))
    }, { rethrow: true })
  },

  toggleEnabled: async (jobId: string, enabled: boolean) => {
    try {
      await invoke('cron_toggle_enabled', { jobId, enabled })
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
    try {
      await invoke('cron_run_job', { jobId })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  loadCronSessionIds: async () => {
    try {
      const ids = await invoke<string[]>('cron_get_all_session_ids')
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
      })
      set({ runs, runsLoading: false })
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
  toggleShowCronSessions: () => set(s => ({ showCronSessions: !s.showCronSessions })),
}))

// ==================== Helpers ====================

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
    const lang = localStorage.getItem(`${appShortName}-language`) || 'en'
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
