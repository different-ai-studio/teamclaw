import { supabase } from '@/lib/supabase-client'

export interface SessionReportInsert {
  actorId: string
  teamId: string
  sessionId?: string | null
  tokensUsed: number
  costUsd: number
  model?: string | null
  agentKind?: string | null
  endedAt?: string | null
}

export async function insertSessionReport(input: SessionReportInsert): Promise<void> {
  const { error } = await supabase.from('actor_session_report').insert({
    actor_id:    input.actorId,
    team_id:     input.teamId,
    session_id:  input.sessionId ?? null,
    tokens_used: input.tokensUsed,
    cost_usd:    input.costUsd,
    model:       input.model ?? null,
    agent_kind:  input.agentKind ?? null,
    ended_at:    input.endedAt ?? null,
  })
  if (error) throw new Error(`insertSessionReport failed: ${error.message}`)
}

export interface LeaderboardRow {
  actor_id: string
  display_name: string | null
  tokens_used_30d: number
  cost_usd_30d: number
  positive_feedback_30d: number
  negative_feedback_30d: number
}

export async function getLeaderboard(teamId: string): Promise<LeaderboardRow[]> {
  const { data, error } = await supabase
    .from('team_leaderboard')
    .select('actor_id, display_name, tokens_used_30d, cost_usd_30d, positive_feedback_30d, negative_feedback_30d')
    .eq('team_id', teamId)
    .order('tokens_used_30d', { ascending: false })
  if (error) throw new Error(`getLeaderboard failed: ${error.message}`)
  return (data ?? []) as LeaderboardRow[]
}
