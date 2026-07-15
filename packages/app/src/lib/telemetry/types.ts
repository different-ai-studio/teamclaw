// ─── Telemetry Types ─────────────────────────────────────────────────────

export type FeedbackRating = 'positive' | 'negative'

export type StarRating = 1 | 2 | 3 | 4 | 5

export type TelemetryConsent = 'granted' | 'denied' | 'undecided'

export interface MessageFeedback {
  id: string
  session_id: string
  message_id: string
  rating: FeedbackRating
  star_rating?: number | null
  created_at: string
}

export interface ScoreResult {
  scorerId: string       // "user-feedback" | "task-completion" | "tool-efficiency"
  score: number          // 0.0 - 1.0
  confidence: number     // 0.0 - 1.0
  reason?: string
  metadata?: Record<string, unknown>
  computedAt: number     // timestamp ms
}

export interface ToolCallSummary {
  name: string
  status: 'completed' | 'failed'
  durationMs: number
}

export interface SessionReport {
  id: string
  session_id: string
  session_title?: string | null
  started_at?: number | null
  completed_at?: number | null
  duration_ms?: number | null
  total_tokens_input: number
  total_tokens_output: number
  total_tokens_reasoning: number
  total_cache_read: number
  total_cache_write: number
  total_cost: number
  message_count: number
  tool_call_count: number
  tool_error_count: number
  tool_calls?: string | null     // JSON string of ToolCallSummary[]
  scores?: string | null         // JSON string of ScoreResult[]
  model_id?: string | null
  provider_id?: string | null
  agent?: string | null
  created_at: string
}
