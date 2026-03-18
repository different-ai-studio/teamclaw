import * as React from 'react'
import { Trophy, Flame, MessageSquareHeart, RefreshCw, Loader2 } from 'lucide-react'
import { cn, isTauri } from '@/lib/utils'
import { Button } from '@/components/ui/button'

async function tauriInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>(cmd, args)
}

function formatTokens(tokens: number | undefined | null): string {
  if (tokens == null || tokens === 0) {
    return '0'
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(2)}K`
  }
  return tokens.toString()
}

// ── Types ──────────────────────────────────────────────────────────

interface LeaderboardStats {
  totalFeedbacks: number
  positiveCount: number
  negativeCount: number
  totalTokens: number
  totalCost: number
  sessionCount: number
}

interface MemberLeaderboardExport {
  memberId: string
  memberName: string
  deviceId: string
  exportedAt: string
  updateAt: string
  workspaces: Record<string, LeaderboardStats>  // workspace path -> stats
}

interface TeamLeaderboard {
  members: MemberLeaderboardExport[]
}

interface MemberStats {
  name: string
  tokenRank: number
  feedbackRank: number
  totalTokens: number
  totalFeedbacks: number
  totalCost: number
  sessionCount: number
  isCurrentUser?: boolean
}

const COLUMNS = [
  { key: 'token', label: 'Token 用量', icon: Flame, color: 'text-amber-500' },
  { key: 'feedback', label: '反馈次数', icon: MessageSquareHeart, color: 'text-pink-500' },
] as const

// ── Component ──────────────────────────────────────────────────────────

export function LeaderboardSection() {
  const [leaderboard, setLeaderboard] = React.useState<TeamLeaderboard | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    if (!isTauri()) return
    setLoading(true)
    setError(null)
    try {
      const result = await tauriInvoke<TeamLeaderboard>("telemetry_get_team_leaderboard")
      setLeaderboard(result)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const handleRefresh = React.useCallback(async () => {
    if (!isTauri()) return
    setLoading(true)
    setError(null)
    
    try {
      console.log('[leaderboard] Exporting stats from .teamclaw/stats.json')
      
      // Export leaderboard (reads from .teamclaw/stats.json)
      await tauriInvoke('telemetry_export_leaderboard')
      
      console.log('[leaderboard] Export complete, reloading data...')
      
      // Wait a moment for file write to complete, then reload
      await new Promise(resolve => setTimeout(resolve, 500))
      
      // Reload leaderboard data
      const result = await tauriInvoke<TeamLeaderboard>("telemetry_get_team_leaderboard")
      setLeaderboard(result)
      
      // Trigger teamclaw-team-synced event to update TeamRankingCard
      window.dispatchEvent(new CustomEvent('teamclaw-team-synced'))
      console.log('[leaderboard] Triggered teamclaw-team-synced event')
    } catch (err) {
      console.error('[leaderboard] Refresh failed:', err)
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  React.useEffect(() => {
    const handler = () => {
      load()
    }
    window.addEventListener("teamclaw-team-synced", handler)
    return () => window.removeEventListener("teamclaw-team-synced", handler)
  }, [load])

  // Aggregate stats from all workspaces for each member
  const aggregateWorkspaceStats = React.useCallback((workspaces: Record<string, LeaderboardStats>) => {
    const total = {
      totalTokens: 0,
      totalFeedbacks: 0,
      totalCost: 0,
      sessionCount: 0,
    }
    
    Object.values(workspaces || {}).forEach(stats => {
      total.totalTokens += stats.totalTokens || 0
      total.totalFeedbacks += stats.totalFeedbacks || 0
      total.totalCost += stats.totalCost || 0
      total.sessionCount += stats.sessionCount || 0
    })
    
    return total
  }, [])

  // Calculate ranks with aggregated workspace data
  const memberStats: MemberStats[] = React.useMemo(() => {
    if (!leaderboard?.members) return []

    // First, aggregate stats for each member
    const membersWithAggregated = leaderboard.members.map(m => ({
      ...m,
      aggregated: aggregateWorkspaceStats(m.workspaces)
    }))

    const tokenSorted = [...membersWithAggregated].sort(
      (a, b) => (b.aggregated.totalTokens) - (a.aggregated.totalTokens)
    )
    const feedbackSorted = [...membersWithAggregated].sort(
      (a, b) => (b.aggregated.totalFeedbacks) - (a.aggregated.totalFeedbacks)
    )

    return membersWithAggregated.map((m) => ({
      name: m.memberName || 'Unknown',
      tokenRank: tokenSorted.findIndex((x) => x.memberId === m.memberId) + 1,
      feedbackRank: feedbackSorted.findIndex((x) => x.memberId === m.memberId) + 1,
      totalTokens: m.aggregated.totalTokens,
      totalFeedbacks: m.aggregated.totalFeedbacks,
      totalCost: m.aggregated.totalCost,
      sessionCount: m.aggregated.sessionCount,
    }))
  }, [leaderboard, aggregateWorkspaceStats])

  const teamSummary = React.useMemo(() => {
    const totalTokens = memberStats.reduce((sum, m) => sum + (m.totalTokens ?? 0), 0)
    const totalFeedbacks = memberStats.reduce((sum, m) => sum + (m.totalFeedbacks ?? 0), 0)
    const totalCost = memberStats.reduce((sum, m) => sum + (m.totalCost ?? 0), 0)
    const totalSessions = memberStats.reduce((sum, m) => sum + (m.sessionCount ?? 0), 0)
    return {
      activeUsers: memberStats.length,
      totalFeedbacks,
      totalTokens,
      totalCost,
      totalSessions,
    }
  }, [memberStats])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-sm">
            <Trophy className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Team Leaderboard</h2>
            <p className="text-xs text-muted-foreground">
              {memberStats.length} members
            </p>
          </div>
        </div>

        {/* Actions */}
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={loading}
          className="gap-1.5"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* Auto-sync info banner */}
      <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 px-4 py-2.5">
        <p className="text-xs text-blue-700 dark:text-blue-300">
          💡 Stats are from <strong>.teamclaw/stats.json</strong> in each workspace. Each member's ranking shows aggregated data from <strong>all their workspaces</strong>. Automatically synced as you work. Click <strong>Refresh</strong> to update immediately.
        </p>
      </div>

      {memberStats.length === 0 && !loading && (
        <p className="text-sm text-muted-foreground">
          No leaderboard data yet. Your stats will be automatically synced when you complete sessions or provide feedback.
        </p>
      )}

      {/* Team summary cards */}
      {memberStats.length > 0 && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Active Users', value: teamSummary.activeUsers, icon: '👥' },
            { label: 'Total Feedbacks', value: teamSummary.totalFeedbacks, icon: '💬' },
            { label: 'Total Tokens', value: formatTokens(teamSummary.totalTokens), icon: '🔥' },
            { label: 'Total Cost', value: `$${teamSummary.totalCost.toFixed(2)}`, icon: '💰' },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-xl border bg-card p-3 text-center"
            >
              <div className="text-lg mb-0.5">{item.icon}</div>
              <div className="text-lg font-bold">{item.value}</div>
              <div className="text-[10px] text-muted-foreground">{item.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Leaderboard table */}
      {memberStats.length > 0 && (
        <>
          <div className="rounded-xl border bg-card overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[40px_1fr_80px_100px_120px] items-center gap-2 px-4 py-2.5 bg-muted/30 border-b text-[11px] font-medium text-muted-foreground">
              <span className="text-center">#</span>
              <span>Member</span>
              <span className="text-center">Token Rank</span>
              <span className="text-center">Feedback Rank</span>
              <span className="text-right">Total Tokens</span>
            </div>

            {/* Rows - sorted by overall performance (average of ranks) */}
            {[...memberStats]
              .sort((a, b) => {
                const avgA = (a.tokenRank + a.feedbackRank) / 2
                const avgB = (b.tokenRank + b.feedbackRank) / 2
                return avgA - avgB
              })
              .map((member, index) => {
                const rank = index + 1
                return (
                  <div
                    key={member.name}
                    className={cn(
                      "grid grid-cols-[40px_1fr_80px_100px_120px] items-center gap-2 px-4 py-2.5 border-b last:border-b-0 transition-colors",
                      member.isCurrentUser
                        ? "bg-indigo-500/[0.06]"
                        : "hover:bg-muted/30"
                    )}
                  >
                    {/* Rank */}
                    <div className="flex justify-center">
                      {rank <= 3 ? (
                        <span className="text-base">
                          {rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉'}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground font-medium tabular-nums">
                          {rank}
                        </span>
                      )}
                    </div>

                    {/* Name */}
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={cn(
                        "shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold",
                        member.isCurrentUser
                          ? "bg-indigo-500 text-white"
                          : "bg-muted text-muted-foreground"
                      )}>
                        {member.name[0]}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className={cn(
                          "text-sm truncate block",
                          member.isCurrentUser && "font-semibold"
                        )}>
                          {member.name}
                          {member.isCurrentUser && (
                            <span className="ml-1.5 text-[10px] font-medium text-indigo-500 bg-indigo-500/10 px-1.5 py-0.5 rounded-full">
                              You
                            </span>
                          )}
                        </span>
                      </div>
                    </div>

                    {/* Token Rank */}
                    <RankCell rank={member.tokenRank} />

                    {/* Feedback Rank */}
                    <RankCell rank={member.feedbackRank} />

                    {/* Total Tokens */}
                    <div className="text-right">
                      <span className="text-sm font-medium tabular-nums">
                        {formatTokens(member.totalTokens)}
                      </span>
                      <div className="text-[10px] text-muted-foreground">
                        {member.totalFeedbacks} feedbacks
                      </div>
                    </div>
                  </div>
                )
              })}
          </div>

          {/* Column legend */}
          <div className="flex items-center justify-center gap-6 text-[11px] text-muted-foreground">
            {COLUMNS.map((col) => {
              const Icon = col.icon
              return (
                <div key={col.key} className="flex items-center gap-1.5">
                  <Icon className={cn("h-3 w-3", col.color)} />
                  <span>{col.label}</span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────

function RankCell({ rank }: { rank: number | undefined }) {
  const safeRank = rank ?? 0
  return (
    <div className="flex justify-center">
      <span className={cn(
        "inline-flex items-center justify-center min-w-[20px] h-5 text-[11px] font-medium tabular-nums rounded-md px-1",
        safeRank === 1
          ? "bg-amber-500/15 text-amber-600"
          : safeRank <= 3
            ? "bg-muted text-foreground"
            : "text-muted-foreground"
      )}>
        {safeRank}
      </span>
    </div>
  )
}
