import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import type {
  LocalStats,
  LocalStatsUpdate,
  FeedbackRating,
  StarRating,
} from '@/lib/local-stats/types'

// ─── Helper ──────────────────────────────────────────────────────────────

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

// ─── Store ───────────────────────────────────────────────────────────────

interface LocalStatsStore {
  stats: LocalStats | null
  isLoading: boolean
  error: string | null
  
  // Actions
  loadStats: (workspacePath: string) => Promise<void>
  incrementTaskCompleted: (workspacePath: string) => Promise<void>
  addTokenUsage: (workspacePath: string, tokens: number, cost: number) => Promise<void>
  incrementFeedback: (workspacePath: string, rating: FeedbackRating) => Promise<void>
  addStarRating: (workspacePath: string, rating: StarRating) => Promise<void>
  incrementSessionCount: (workspacePath: string, hasFeedback?: boolean) => Promise<void>
  incrementSkillUsage: (workspacePath: string, skillName: string) => Promise<void>
  resetStats: (workspacePath: string) => Promise<void>
  
  // Internal
  _updateStats: (workspacePath: string, updates: LocalStatsUpdate) => Promise<void>
}

export const useLocalStatsStore = create<LocalStatsStore>((set, get) => ({
  stats: null,
  isLoading: false,
  error: null,
  
  loadStats: async (workspacePath: string) => {
    if (!isTauri() || !workspacePath) return
    
    set({ isLoading: true, error: null })
    try {
      const stats = await invoke<LocalStats>('read_local_stats', { workspacePath })
      set({ stats, isLoading: false })
      console.log('[LocalStats] Loaded:', stats)
    } catch (err) {
      console.error('[LocalStats] Failed to load:', err)
      set({ error: String(err), isLoading: false })
    }
  },
  
  incrementTaskCompleted: async (workspacePath: string) => {
    if (!isTauri() || !workspacePath) return
    
    try {
      await get()._updateStats(workspacePath, { taskCompleted: 1 })
      console.log('[LocalStats] Incremented task completed')
    } catch (err) {
      console.error('[LocalStats] Failed to increment task:', err)
    }
  },
  
  addTokenUsage: async (workspacePath: string, tokens: number, cost: number) => {
    if (!isTauri() || !workspacePath) return
    
    try {
      await get()._updateStats(workspacePath, { 
        totalTokens: tokens, 
        totalCost: cost 
      })
      console.log(`[LocalStats] Added token usage: ${tokens} tokens, $${cost.toFixed(4)}`)
    } catch (err) {
      console.error('[LocalStats] Failed to add token usage:', err)
    }
  },
  
  incrementFeedback: async (workspacePath: string, rating: FeedbackRating) => {
    if (!isTauri() || !workspacePath) return
    
    try {
      const updates: LocalStatsUpdate = {
        feedbackCount: 1,
        positiveCount: rating === 'positive' ? 1 : 0,
        negativeCount: rating === 'negative' ? 1 : 0,
      }
      await get()._updateStats(workspacePath, updates)
      console.log(`[LocalStats] Incremented ${rating} feedback`)
    } catch (err) {
      console.error('[LocalStats] Failed to increment feedback:', err)
    }
  },
  
  addStarRating: async (workspacePath: string, rating: StarRating) => {
    if (!isTauri() || !workspacePath) return
    
    try {
      await get()._updateStats(workspacePath, { starRating: rating })
      console.log(`[LocalStats] Added ${rating}-star rating`)
    } catch (err) {
      console.error('[LocalStats] Failed to add star rating:', err)
    }
  },
  
  incrementSessionCount: async (workspacePath: string, hasFeedback = false) => {
    if (!isTauri() || !workspacePath) return
    
    try {
      const updates: LocalStatsUpdate = {
        sessionsTotal: 1,
        sessionsWithFeedback: hasFeedback ? 1 : 0,
      }
      await get()._updateStats(workspacePath, updates)
      console.log('[LocalStats] Incremented session count')
    } catch (err) {
      console.error('[LocalStats] Failed to increment session count:', err)
    }
  },
  
  incrementSkillUsage: async (workspacePath: string, skillName: string) => {
    if (!isTauri() || !workspacePath || !skillName) return

    try {
      await get()._updateStats(workspacePath, { skillInvoked: skillName })
      console.log(`[LocalStats] Incremented skill usage: ${skillName}`)
    } catch (err) {
      console.error('[LocalStats] Failed to increment skill usage:', err)
    }
  },

  resetStats: async (workspacePath: string) => {
    if (!isTauri() || !workspacePath) return
    
    set({ isLoading: true, error: null })
    try {
      const stats = await invoke<LocalStats>('reset_local_stats', { workspacePath })
      set({ stats, isLoading: false })
      console.log('[LocalStats] Reset stats')
    } catch (err) {
      console.error('[LocalStats] Failed to reset:', err)
      set({ error: String(err), isLoading: false })
    }
  },
  
  _updateStats: async (workspacePath: string, updates: LocalStatsUpdate) => {
    const stats = await invoke<LocalStats>('update_local_stats', {
      workspacePath,
      updates,
    })
    set({ stats })
    
    // Auto-trigger team leaderboard export after local stats update
    try {
      const { triggerTeamLeaderboardExport } = await import('./telemetry')
      triggerTeamLeaderboardExport()
    } catch (err) {
      // Silently fail if telemetry is not available (e.g., web mode or no P2P)
      console.debug('[LocalStats] Could not trigger team leaderboard export:', err)
    }
  },
}))

// ─── Auto-load on workspace change ───────────────────────────────────────

/**
 * Call this function when workspace path changes to auto-load stats
 */
export function loadLocalStatsForWorkspace(workspacePath: string | null) {
  if (workspacePath) {
    useLocalStatsStore.getState().loadStats(workspacePath)
  }
}
