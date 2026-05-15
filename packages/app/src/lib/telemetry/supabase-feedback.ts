import { supabase } from '@/lib/supabase-client'

export type FeedbackKind = 'positive' | 'negative'

export interface FeedbackInsert {
  actorId: string
  teamId: string
  sessionId?: string | null
  messageId?: string | null
  kind: FeedbackKind
  starRating?: number | null
  skill?: string | null
}

export async function insertFeedback(input: FeedbackInsert): Promise<void> {
  const { error } = await supabase.from('actor_message_feedback').insert({
    actor_id: input.actorId,
    team_id: input.teamId,
    session_id: input.sessionId ?? null,
    message_id: input.messageId ?? null,
    kind: input.kind,
    star_rating: input.starRating ?? null,
    skill: input.skill ?? null,
  })
  if (error) throw new Error(`insertFeedback failed: ${error.message}`)
}

export interface FeedbackSummaryRow {
  actor_id: string
  display_name: string | null
  positive_feedback_30d: number
  negative_feedback_30d: number
}

export async function getTeamFeedbackSummary(teamId: string): Promise<FeedbackSummaryRow[]> {
  const { data, error } = await supabase
    .from('team_leaderboard')
    .select('actor_id, display_name, positive_feedback_30d, negative_feedback_30d')
    .eq('team_id', teamId)
  if (error) throw new Error(`getTeamFeedbackSummary failed: ${error.message}`)
  return (data ?? []) as FeedbackSummaryRow[]
}
