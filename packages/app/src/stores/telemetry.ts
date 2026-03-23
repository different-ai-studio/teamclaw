import { create } from 'zustand'
import type {
  TelemetryConsent,
  FeedbackRating,
  StarRating,
} from '@/lib/telemetry/types'
import { ScoringEngine } from '@/lib/telemetry/scoring-engine'
import { buildSessionReport } from '@/lib/telemetry/report-builder'
import { useSessionStore } from '@/stores/session'
import { getOpenCodeClient } from '@/lib/opencode/client'
import { isTauri } from '@/lib/utils'
import type { Message as OpenCodeMessage } from '@/lib/opencode/types'

// ─── Helpers ─────────────────────────────────────────────────────────────

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

// ─── Types ───────────────────────────────────────────────────────────────

interface TelemetryState {
  // State
  consent: TelemetryConsent
  isInitialized: boolean
  feedbackCache: Map<string, FeedbackRating> // messageId -> rating
  starRatingCache: Map<string, StarRating> // messageId -> 1-5
  isGeneratingReports: boolean

  // Actions
  init: () => Promise<void>
  setConsent: (consent: TelemetryConsent) => Promise<void>
  setFeedback: (sessionId: string, messageId: string, rating: FeedbackRating) => Promise<void>
  removeFeedback: (sessionId: string, messageId: string) => Promise<void>
  setStarRating: (sessionId: string, messageId: string, rating: StarRating) => Promise<void>
  removeStarRating: (sessionId: string, messageId: string) => Promise<void>
  loadFeedbacks: (sessionId: string) => Promise<void>
  getFeedback: (messageId: string) => FeedbackRating | undefined
  getStarRating: (messageId: string) => StarRating | undefined
  handleSessionIdle: (sessionId: string) => void
  generateAllSessionReports: (workspacePath?: string) => Promise<void>
  exportTeamData: (force?: boolean) => void
  destroy: () => void
}

// ─── Internal state ──────────────────────────────────────────────────────

const scoringEngine = new ScoringEngine()
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
const scoredSessions = new Set<string>()

const TEAM_EXPORT_DEBOUNCE_MS = 5 * 60 * 1000 // 5 min
let teamExportTimerId: ReturnType<typeof setTimeout> | null = null
let lastTeamExportAt = 0


/**
 * Ensure a session's messages are loaded before building session report.
 * Prevents token statistics from being 0 for historical sessions.
 */
async function ensureSessionMessagesLoaded(sessionId: string): Promise<void> {
  const sessionStore = useSessionStore.getState()
  const messages = sessionStore.getSessionMessages(sessionId)
  
  // If session has messages with token data, we're good
  if (messages && messages.length > 0) {
    const hasTokenData = messages.some(msg => msg.role === 'assistant' && msg.tokens)
    if (hasTokenData) {
      return
    }
  }
  
  // Session has no messages or no token data - load from API
  console.log(`[telemetry] Loading messages for session ${sessionId}`)
  
  try {
    const client = getOpenCodeClient()
    const apiMessages = await client.getMessages(sessionId)
    
    // Convert OpenCode messages to our format
    const convertedMessages = apiMessages.map((msg: OpenCodeMessage) => ({
      id: msg.info.id,
      sessionId: msg.info.sessionID,
      role: msg.info.role as 'user' | 'assistant' | 'system',
      content: msg.parts
        ?.filter(p => p.type === 'text')
        .map(p => p.text || '')
        .join('') || '',
      parts: (msg.parts || []).map((p) => ({
        id: p.id,
        type: p.type,
        text: p.text,
        content: p.text,
      })),
      timestamp: msg.info.time?.created ? new Date(msg.info.time.created) : new Date(),
      tokens: msg.info.tokens,
      cost: msg.info.cost,
      modelID: msg.info.modelID,
      providerID: msg.info.providerID,
      agent: msg.info.agent,
      toolCalls: [],
    }))
    
    // Update the session in the store
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId ? { ...s, messages: convertedMessages } : s
      )
    }))
    
    console.log(`[telemetry] Loaded ${convertedMessages.length} messages for session ${sessionId}`)
  } catch (err) {
    console.error(`[telemetry] Failed to load messages for session ${sessionId}:`, err)
    // Don't throw - let the report builder handle the empty message case
  }
}

// ─── Store ───────────────────────────────────────────────────────────────

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  consent: 'undecided',
  isInitialized: false,
  feedbackCache: new Map(),
  starRatingCache: new Map(),
  isGeneratingReports: false,

  init: async () => {
    if (!isTauri()) {
      set({ isInitialized: true })
      return
    }

    try {
      const consent = await invoke<string>('telemetry_get_consent')

      set({
        consent: consent as TelemetryConsent,
        isInitialized: true,
      })

      // Generate session reports after a short delay to avoid blocking init
      if (consent === 'granted') {
        setTimeout(async () => {
          const workspacePath = (await import('@/stores/workspace')).useWorkspaceStore.getState().workspacePath
          get().generateAllSessionReports(workspacePath ?? undefined)
        }, 5000) // 5 seconds delay
      }
    } catch (err) {
      console.error('[telemetry] Failed to initialize:', err)
      set({ isInitialized: true })
    }
  },

  setConsent: async (consent: TelemetryConsent) => {
    if (!isTauri()) return

    try {
      await invoke('telemetry_set_consent', { consent })
      set({ consent })
    } catch (err) {
      console.error('[telemetry] Failed to set consent:', err)
    }
  },

  setFeedback: async (sessionId: string, messageId: string, rating: FeedbackRating) => {
    if (!isTauri()) return

    try {
      await invoke('telemetry_set_feedback', {
        sessionId,
        messageId,
        rating,
      })

      set((state) => {
        const cache = new Map(state.feedbackCache)
        cache.set(messageId, rating)
        return { feedbackCache: cache }
      })

      // Trigger session report creation/update for this session
      get().handleSessionIdle(sessionId)

      // Schedule team data export after feedback change
      scheduleTeamFeedbackExport()

      // Update local stats
      const { useWorkspaceStore } = await import('@/stores/workspace')
      const { useLocalStatsStore } = await import('@/stores/local-stats')
      const workspacePath = useWorkspaceStore.getState().workspacePath
      if (workspacePath) {
        await useLocalStatsStore.getState().incrementFeedback(workspacePath, rating)
      }
    } catch (err) {
      console.error('[telemetry] Failed to set feedback:', err)
    }
  },

  removeFeedback: async (sessionId: string, messageId: string) => {
    if (!isTauri()) return

    try {
      await invoke('telemetry_remove_feedback', { sessionId, messageId })

      set((state) => {
        const cache = new Map(state.feedbackCache)
        cache.delete(messageId)
        return { feedbackCache: cache }
      })

      // Trigger session report creation/update for this session
      get().handleSessionIdle(sessionId)

      // Schedule team data export after feedback removal
      scheduleTeamFeedbackExport()
    } catch (err) {
      console.error('[telemetry] Failed to remove feedback:', err)
    }
  },

  loadFeedbacks: async (sessionId: string) => {
    if (!isTauri()) return

    try {
      const feedbacks = await invoke<Array<{ message_id: string; rating: string; star_rating?: number | null }>>(
        'telemetry_get_feedbacks',
        { sessionId },
      )

      set((state) => {
        const cache = new Map(state.feedbackCache)
        const starCache = new Map(state.starRatingCache)
        for (const fb of feedbacks) {
          cache.set(fb.message_id, fb.rating as FeedbackRating)
          if (fb.star_rating != null && fb.star_rating >= 1 && fb.star_rating <= 5) {
            starCache.set(fb.message_id, fb.star_rating as StarRating)
          }
        }
        return { feedbackCache: cache, starRatingCache: starCache }
      })
    } catch (err) {
      console.error('[telemetry] Failed to load feedbacks:', err)
    }
  },

  getFeedback: (messageId: string) => {
    return get().feedbackCache.get(messageId)
  },

  setStarRating: async (sessionId: string, messageId: string, rating: StarRating) => {
    if (!isTauri()) return

    try {
      await invoke('telemetry_set_star_rating', {
        sessionId,
        messageId,
        starRating: rating,
      })

      set((state) => {
        const cache = new Map(state.starRatingCache)
        cache.set(messageId, rating)
        return { starRatingCache: cache }
      })

      // Trigger session report creation/update for this session
      get().handleSessionIdle(sessionId)

      // Schedule team data export after star rating change
      scheduleTeamFeedbackExport()

      // Update local stats
      const { useWorkspaceStore } = await import('@/stores/workspace')
      const { useLocalStatsStore } = await import('@/stores/local-stats')
      const workspacePath = useWorkspaceStore.getState().workspacePath
      if (workspacePath) {
        await useLocalStatsStore.getState().addStarRating(workspacePath, rating)
      }
    } catch (err) {
      console.error('[telemetry] Failed to set star rating:', err)
    }
  },

  removeStarRating: async (sessionId: string, messageId: string) => {
    if (!isTauri()) return

    try {
      await invoke('telemetry_remove_star_rating', { sessionId, messageId })

      set((state) => {
        const cache = new Map(state.starRatingCache)
        cache.delete(messageId)
        return { starRatingCache: cache }
      })

      // Trigger session report creation/update for this session
      get().handleSessionIdle(sessionId)

      // Schedule team data export after star rating removal
      scheduleTeamFeedbackExport()
    } catch (err) {
      console.error('[telemetry] Failed to remove star rating:', err)
    }
  },

  getStarRating: (messageId: string) => {
    return get().starRatingCache.get(messageId)
  },

  handleSessionIdle: (sessionId: string) => {
    const { consent } = get()
    if (consent !== 'granted') return

    // Cancel any existing timer for this session
    const existingTimer = idleTimers.get(sessionId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Set a 2-second debounce timer
    const timer = setTimeout(async () => {
      idleTimers.delete(sessionId)

      // Deduplication: don't score same session twice in quick succession
      if (scoredSessions.has(sessionId)) return
      scoredSessions.add(sessionId)

      // Allow re-scoring after 60 seconds
      setTimeout(() => scoredSessions.delete(sessionId), 60_000)

      try {
        const { feedbackCache, starRatingCache } = get()

        // Ensure session messages are loaded before building report
        await ensureSessionMessagesLoaded(sessionId)

        // Build the session report
        const report = buildSessionReport(sessionId, feedbackCache, starRatingCache)
        if (!report) {
          console.warn(`[telemetry] Failed to build report for session ${sessionId} - no messages or session not found`)
          return
        }

        // Run scoring engine
        const scores = await scoringEngine.score(report)
        report.scores = JSON.stringify(scores)

        // Remove internal scorer metadata before saving
        const cleanReport = { ...report }
        delete (cleanReport as Record<string, unknown>)._feedbackPositive
        delete (cleanReport as Record<string, unknown>)._feedbackNegative
        delete (cleanReport as Record<string, unknown>)._starRatings

        // Save to libSQL
        await invoke('telemetry_save_report', { report: cleanReport })
        console.log(`[telemetry] Scored session ${sessionId}:`, scores.length, 'scores')

        scheduleTeamFeedbackExport()

        // Update local stats: task completed and session count
        // Note: Token usage is now tracked per message in handleMessageCompleted
        const { useWorkspaceStore } = await import('@/stores/workspace')
        const { useLocalStatsStore } = await import('@/stores/local-stats')
        const workspacePath = useWorkspaceStore.getState().workspacePath
        if (workspacePath) {
          const localStatsStore = useLocalStatsStore.getState()
          
          // Increment task completed
          await localStatsStore.incrementTaskCompleted(workspacePath)
          
          // Increment session count (with feedback if applicable)
          const feedbackPositive = (report as { _feedbackPositive?: number })._feedbackPositive || 0
          const feedbackNegative = (report as { _feedbackNegative?: number })._feedbackNegative || 0
          const hasFeedback = feedbackPositive + feedbackNegative > 0
          await localStatsStore.incrementSessionCount(workspacePath, hasFeedback)
        }
      } catch (err) {
        console.error('[telemetry] Scoring failed for session:', sessionId, err)
      }
    }, 2000)

    idleTimers.set(sessionId, timer)
  },

  generateAllSessionReports: async (workspacePath?: string) => {
    if (!isTauri()) return
    const { consent, isGeneratingReports } = get()
    if (consent !== 'granted') {
      console.log('[telemetry] Skipping report generation - consent not granted')
      return
    }
    if (isGeneratingReports) {
      console.log('[telemetry] Report generation already in progress')
      return
    }

    set({ isGeneratingReports: true })
    console.log('[telemetry] Starting automatic session report generation')

    try {
      const sessionStore = useSessionStore.getState()
      
      // Load all sessions and their messages (same as Token Usage page)
      console.log('[telemetry] Loading all session messages...')
      await sessionStore.loadAllSessionMessages(workspacePath)

      const sessions = sessionStore.sessions
      console.log(`[telemetry] Processing ${sessions.length} sessions`)

      const { feedbackCache, starRatingCache } = get()
      let successCount = 0
      let skipCount = 0
      let errorCount = 0

      // Process sessions in batches of 5 to avoid overwhelming the system
      const BATCH_SIZE = 5
      for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
        const batch = sessions.slice(i, i + BATCH_SIZE)
        
        await Promise.allSettled(
          batch.map(async (session) => {
            try {
              // Skip if this session was already scored recently (within 60s)
              if (scoredSessions.has(session.id)) {
                skipCount++
                return
              }

              // Check if session has messages with token data
              const hasTokenData = session.messages.some(
                msg => msg.role === 'assistant' && msg.tokens
              )
              
              if (!hasTokenData) {
                skipCount++
                return
              }

              // Build session report
              const report = buildSessionReport(session.id, feedbackCache, starRatingCache)
              if (!report) {
                skipCount++
                return
              }

              // Run scoring engine
              const scores = await scoringEngine.score(report)
              report.scores = JSON.stringify(scores)

              // Remove internal scorer metadata before saving
              const cleanReport = { ...report }
              delete (cleanReport as Record<string, unknown>)._feedbackPositive
              delete (cleanReport as Record<string, unknown>)._feedbackNegative
              delete (cleanReport as Record<string, unknown>)._starRatings

              // Save to database
              await invoke('telemetry_save_report', { report: cleanReport })
              
              // Mark as scored to prevent re-processing
              scoredSessions.add(session.id)
              setTimeout(() => scoredSessions.delete(session.id), 60_000)
              
              successCount++
            } catch (err) {
              console.error(`[telemetry] Failed to generate report for session ${session.id}:`, err)
              errorCount++
            }
          })
        )
      }

      console.log(`[telemetry] Report generation complete: ${successCount} created, ${skipCount} skipped, ${errorCount} errors`)

      // Export team data after generating reports
      if (successCount > 0) {
        scheduleTeamFeedbackExport()
      }
    } catch (err) {
      console.error('[telemetry] Failed to generate session reports:', err)
    } finally {
      set({ isGeneratingReports: false })
    }
  },

  exportTeamData: (force?: boolean) => {
    scheduleTeamFeedbackExport(force)
  },

  destroy: () => {
    for (const timer of idleTimers.values()) {
      clearTimeout(timer)
    }
    idleTimers.clear()
    scoredSessions.clear()
    if (teamExportTimerId) {
      clearTimeout(teamExportTimerId)
      teamExportTimerId = null
    }
  },
}))

// ─── Debug Helper ────────────────────────────────────────────────────

/**
 * Expose telemetry store for debugging in browser console.
 * Usage: window.__TEAMCLAW_TELEMETRY__.generateAllSessionReports()
 */
if (typeof window !== 'undefined') {
  (window as unknown as { __TEAMCLAW_TELEMETRY__: TelemetryState }).__TEAMCLAW_TELEMETRY__ = useTelemetryStore.getState()
}

// ─── Team Feedback & Leaderboard Export ──────────────────────────────────

function scheduleTeamFeedbackExport(force: boolean = false) {
  if (!isTauri()) return

  const now = Date.now()
  const elapsed = now - lastTeamExportAt
  if (!force && elapsed < TEAM_EXPORT_DEBOUNCE_MS && teamExportTimerId) return

  if (teamExportTimerId) {
    clearTimeout(teamExportTimerId)
  }

  const delay = force ? 1000 : (elapsed >= TEAM_EXPORT_DEBOUNCE_MS ? 3000 : TEAM_EXPORT_DEBOUNCE_MS - elapsed)
  teamExportTimerId = setTimeout(async () => {
    teamExportTimerId = null
    try {
      console.log('[telemetry] Exporting team data from .teamclaw/stats.json')
      
      // Export both feedback and leaderboard data
      // Note: leaderboard now reads from .teamclaw/stats.json directly
      await Promise.all([
        invoke('telemetry_export_team_feedback', {}),
        invoke('telemetry_export_leaderboard', {}),
      ])
      lastTeamExportAt = Date.now()
      console.log('[telemetry] Exported team feedback & leaderboard')
    } catch (err) {
      console.error('[telemetry] Failed to export team data:', err)
    }
  }, delay)
}

/**
 * Trigger team leaderboard export (with debouncing)
 * Call this after updating .teamclaw/stats.json to sync changes to team leaderboard
 */
export function triggerTeamLeaderboardExport() {
  scheduleTeamFeedbackExport()
}
