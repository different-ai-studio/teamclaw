/**
 * Local statistics types for project-level tracking
 * Stored in .teamclaw/stats.json (not uploaded, project-specific)
 */

export interface LocalStats {
  version: string
  taskCompleted: number      // Number of completed tasks/sessions
  totalTokens: number         // Total tokens consumed
  totalCost: number          // Total cost in USD
  feedbackCount: number      // Total feedback count
  positiveCount: number      // Positive feedback count
  negativeCount: number      // Negative feedback count
  starRatings: StarRatings   // Star rating distribution
  sessions: SessionStats     // Session statistics
  lastUpdated: string        // ISO 8601 timestamp
  createdAt: string          // ISO 8601 timestamp
}

export interface StarRatings {
  1: number
  2: number
  3: number
  4: number
  5: number
}

export interface SessionStats {
  total: number              // Total number of sessions
  withFeedback: number       // Sessions with at least one feedback
}

export interface LocalStatsUpdate {
  taskCompleted?: number
  totalTokens?: number
  totalCost?: number
  feedbackCount?: number
  positiveCount?: number
  negativeCount?: number
  starRating?: 1 | 2 | 3 | 4 | 5
  sessionsTotal?: number
  sessionsWithFeedback?: number
}

export type FeedbackRating = 'positive' | 'negative'
export type StarRating = 1 | 2 | 3 | 4 | 5
