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
    } catch (err) {
      console.error('[LocalStats] Failed to increment skill usage:', err)
    }

    // Mirror to cloud so the team leaderboard skill dimension is populated.
    // This is best-effort: a cloud failure must not prevent or throw from the
    // local write above.
    //
    // TRIGGER NOTE: This function is ready and wired, but callers must exist
    // at the point where skills actually run. The primary frontend hook is in
    // App.tsx at the `toolUse` ACP event (case "skill") — see the `toolUse`
    // handler in the `listenForEnvelopes` callback. Skills that run entirely
    // inside the daemon/agent runtime without emitting a `toolUse` ACP event
    // to the frontend will not be captured here; those require a separate
    // daemon-side call (e.g. from `apps/daemon/src/teamclaw/rpc.rs`).
    try {
      const { useCurrentTeamStore } = await import('@/stores/current-team')
      const teamId = useCurrentTeamStore.getState().team?.id
      if (!teamId) return
      const { useAuthStore } = await import('@/stores/auth-store')
      const userId = useAuthStore.getState().session?.user?.id
      if (!userId) return
      const { resolveCurrentMemberActorId } = await import('@/lib/current-actor')
      const actorId = await resolveCurrentMemberActorId(teamId, userId)
      if (!actorId) return
      const { getBackend } = await import('@/lib/backend')
      await getBackend().telemetry.insertSkillUsage({ actorId, teamId, skill: skillName, count: 1 })
    } catch (err) {
      console.error('[LocalStats] Failed to report skill usage to cloud:', err)
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
      // Silently fail if telemetry is not available.
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
