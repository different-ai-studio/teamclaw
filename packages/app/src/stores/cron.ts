import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { withAsync } from '@/lib/store-utils'

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
}

export type DeliveryMode = 'announce' | 'none'
export type DeliveryChannel = 'discord' | 'feishu' | 'email' | 'kook' | 'wechat'

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

  // Run history for the currently viewed job
  selectedJobId: string | null
  runs: CronRunRecord[]
  runsLoading: boolean

  // Actions
  init: () => Promise<void>
  reinit: () => Promise<void>
  loadJobs: () => Promise<void>
  addJob: (request: CreateCronJobRequest) => Promise<CronJob>
  updateJob: (request: UpdateCronJobRequest) => Promise<CronJob>
  removeJob: (jobId: string) => Promise<void>
  toggleEnabled: (jobId: string, enabled: boolean) => Promise<void>
  runJob: (jobId: string) => Promise<void>
  loadRuns: (jobId: string, limit?: number) => Promise<void>
  refreshDelivery: () => Promise<void>
  clearError: () => void
  setSelectedJobId: (jobId: string | null) => void
}

export const useCronStore = create<CronState>((set, get) => ({
  jobs: [],
  isLoading: false,
  error: null,
  isInitialized: false,

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
      await get().loadJobs()
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
      await get().loadJobs()
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

/** Format a relative time string (e.g., "2 min ago") */
export function formatRelativeTime(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffSec = Math.floor(diffMs / 1000)

    if (diffSec < 0) {
      // Future
      const absSec = Math.abs(diffSec)
      if (absSec < 60) return `in ${absSec}s`
      if (absSec < 3600) return `in ${Math.floor(absSec / 60)} min`
      if (absSec < 86400) return `in ${Math.floor(absSec / 3600)}h`
      return `in ${Math.floor(absSec / 86400)} days`
    }

    if (diffSec < 60) return `${diffSec}s ago`
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
    return `${Math.floor(diffSec / 86400)} days ago`
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
