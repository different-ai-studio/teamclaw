import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/lib/store-utils', () => ({
  withAsync: async (set: any, fn: any, opts?: any) => {
    set({ isLoading: true, error: null })
    try {
      const result = await fn()
      set({ isLoading: false })
      return result
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), isLoading: false })
      if (opts?.rethrow) throw error
    }
  },
}))

import { useCronStore, formatSchedule, formatRelativeTime, getRunStatusColor, getChannelDisplayName } from '@/stores/cron'

describe('cron store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCronStore.setState({
      jobs: [],
      isLoading: false,
      error: null,
      isInitialized: false,
      selectedJobId: null,
      runs: [],
      runsLoading: false,
    })
  })

  it('has correct initial state', () => {
    const state = useCronStore.getState()
    expect(state.jobs).toEqual([])
    expect(state.isLoading).toBe(false)
    expect(state.isInitialized).toBe(false)
  })

  it('init calls cron_init and loads jobs', async () => {
    mockInvoke.mockResolvedValueOnce(undefined) // cron_init
    mockInvoke.mockResolvedValueOnce([]) // cron_list_jobs via loadJobs
    await useCronStore.getState().init()
    expect(mockInvoke).toHaveBeenCalledWith('cron_init')
    expect(useCronStore.getState().isInitialized).toBe(true)
  })

  it('clearError resets error', () => {
    useCronStore.setState({ error: 'fail' })
    useCronStore.getState().clearError()
    expect(useCronStore.getState().error).toBeNull()
  })

  it('setSelectedJobId updates selected job', () => {
    useCronStore.getState().setSelectedJobId('job-123')
    expect(useCronStore.getState().selectedJobId).toBe('job-123')
  })
})

describe('cron helpers', () => {
  it('formatSchedule handles "at" kind', () => {
    expect(formatSchedule({ kind: 'at' })).toBe('One-time')
    expect(formatSchedule({ kind: 'at', at: '2025-01-01T00:00:00Z' })).toContain('One-time')
  })

  it('formatSchedule handles "every" kind', () => {
    expect(formatSchedule({ kind: 'every', everyMs: 30000 })).toBe('Every 30s')
    expect(formatSchedule({ kind: 'every', everyMs: 120000 })).toBe('Every 2 min')
    expect(formatSchedule({ kind: 'every', everyMs: 7200000 })).toBe('Every 2h')
    expect(formatSchedule({ kind: 'every', everyMs: 172800000 })).toBe('Every 2 days')
  })

  it('formatSchedule handles "cron" kind', () => {
    expect(formatSchedule({ kind: 'cron', expr: '0 9 * * *' })).toBe('Cron: 0 9 * * *')
    expect(formatSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })).toBe('Cron: 0 9 * * * (UTC)')
  })

  it('getRunStatusColor returns correct colors', () => {
    expect(getRunStatusColor('success')).toBe('text-green-500')
    expect(getRunStatusColor('failed')).toBe('text-red-500')
    expect(getRunStatusColor('timeout')).toBe('text-orange-500')
    expect(getRunStatusColor('running')).toBe('text-blue-500')
  })

  it('getChannelDisplayName returns correct names', () => {
    expect(getChannelDisplayName('discord')).toBe('Discord')
    expect(getChannelDisplayName('feishu')).toBe('Feishu')
    expect(getChannelDisplayName('email')).toBe('Email')
    expect(getChannelDisplayName('kook')).toBe('KOOK')
  })

  it('formatRelativeTime formats past times', () => {
    const now = new Date()
    const tenSecsAgo = new Date(now.getTime() - 10000).toISOString()
    expect(formatRelativeTime(tenSecsAgo)).toBe('10s ago')

    const fiveMinsAgo = new Date(now.getTime() - 300000).toISOString()
    expect(formatRelativeTime(fiveMinsAgo)).toBe('5 min ago')
  })
})
