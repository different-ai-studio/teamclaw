import * as React from 'react'
import { Trophy, Flame, MessageSquareHeart, ChevronRight } from 'lucide-react'
import { cn, isTauri } from '@/lib/utils'
import { useTeamModeStore } from '@/stores/team-mode'

async function tauriInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>(cmd, args)
}

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
  exportedAt: string
  updateAt: string
  workspaces: Record<string, LeaderboardStats>  // workspace path -> stats
}

interface TeamLeaderboard {
  members: MemberLeaderboardExport[]
}

function getRankEmoji(rank: number) {
  if (rank === 1) return '🥇'
  if (rank === 2) return '🥈'
  if (rank === 3) return '🥉'
  return `#${rank}`
}

interface TeamRankingCardProps {
  onClick: () => void
}

export function TeamRankingCard({ onClick }: TeamRankingCardProps) {
  const [leaderboard, setLeaderboard] = React.useState<TeamLeaderboard | null>(null)
  const [currentDeviceId, setCurrentDeviceId] = React.useState<string | null>(null)
  const teamMode = useTeamModeStore((s) => s.teamMode)

  React.useEffect(() => {
    const load = async () => {
      if (!isTauri()) return
      try {
        const [leaderboardResult, nodeId] = await Promise.all([
          tauriInvoke<TeamLeaderboard>("telemetry_get_team_leaderboard"),
          tauriInvoke<string>("get_device_node_id"),
        ])
        setLeaderboard(leaderboardResult)
        setCurrentDeviceId(nodeId)
      } catch {
        // Ignore errors
      }
    }
    load()

    const handler = () => {
      load()
    }
    window.addEventListener("teamclaw-team-synced", handler)
    return () => window.removeEventListener("teamclaw-team-synced", handler)
  }, [])

  // Clear leaderboard data when team mode is disabled
  React.useEffect(() => {
    if (!teamMode) {
      setLeaderboard(null)
      setCurrentDeviceId(null)
    }
  }, [teamMode])

  // Calculate current user's rank
  const currentMember = React.useMemo(() => {
    if (!leaderboard?.members || !currentDeviceId) return null
    return leaderboard.members.find((m) => m.memberId === currentDeviceId)
  }, [leaderboard, currentDeviceId])

  const ranks = React.useMemo(() => {
    if (!leaderboard?.members || !currentMember) {
      return { tokenRank: 0, feedbackRank: 0, overallRank: 0, totalMembers: 0 }
    }

    // Aggregate stats from all workspaces for each member
    const membersWithAggregated = leaderboard.members.map(m => {
      const aggregated = {
        totalTokens: 0,
        totalFeedbacks: 0,
      }
      Object.values(m.workspaces || {}).forEach(stats => {
        aggregated.totalTokens += stats.totalTokens || 0
        aggregated.totalFeedbacks += stats.totalFeedbacks || 0
      })
      return {
        ...m,
        aggregated
      }
    })

    const tokenSorted = [...membersWithAggregated].sort(
      (a, b) => b.aggregated.totalTokens - a.aggregated.totalTokens
    )
    const feedbackSorted = [...membersWithAggregated].sort(
      (a, b) => b.aggregated.totalFeedbacks - a.aggregated.totalFeedbacks
    )

    const tokenRank = tokenSorted.findIndex((m) => m.memberId === currentDeviceId) + 1
    const feedbackRank = feedbackSorted.findIndex((m) => m.memberId === currentDeviceId) + 1

    // Overall rank based on average of token and feedback ranks
    const memberRanks = membersWithAggregated.map((m) => {
      const tRank = tokenSorted.findIndex((x) => x.memberId === m.memberId) + 1
      const fRank = feedbackSorted.findIndex((x) => x.memberId === m.memberId) + 1
      return {
        memberId: m.memberId,
        avgRank: (tRank + fRank) / 2,
      }
    })
    memberRanks.sort((a, b) => a.avgRank - b.avgRank)
    const overallRank = memberRanks.findIndex((m) => m.memberId === currentDeviceId) + 1

    return {
      tokenRank,
      feedbackRank,
      overallRank,
      totalMembers: leaderboard.members.length,
    }
  }, [leaderboard, currentMember, currentDeviceId])

  const { overallRank, totalMembers, tokenRank, feedbackRank } = ranks

  const stats = [
    { label: 'Token Usage', rank: tokenRank, icon: Flame, color: 'text-amber-300' },
    { label: 'Feedback Count', rank: feedbackRank, icon: MessageSquareHeart, color: 'text-pink-300' },
  ]

  if (totalMembers === 0) {
    return (
      <button
        onClick={onClick}
        className={cn(
          "w-full text-left rounded-xl p-4 transition-all duration-200",
          "bg-gradient-to-br from-violet-600/50 via-indigo-600/50 to-blue-600/50",
          "hover:from-violet-500/50 hover:via-indigo-500/50 hover:to-blue-500/50",
          "border border-white/10",
          "group cursor-pointer",
        )}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/10">
            <Trophy className="h-5 w-5 text-white/50" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white/90">Team Ranking</p>
            <p className="text-xs text-white/50 mt-0.5">Click to view</p>
          </div>
          <ChevronRight className="h-4 w-4 text-white/30 group-hover:text-white/70 transition-colors" />
        </div>
      </button>
    )
  }

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-xl p-4 transition-all duration-200",
        "bg-gradient-to-br from-violet-600 via-indigo-600 to-blue-600",
        "hover:from-violet-500 hover:via-indigo-500 hover:to-blue-500",
        "hover:shadow-lg hover:shadow-indigo-500/25 hover:-translate-y-0.5",
        "active:translate-y-0",
        "group cursor-pointer",
      )}
    >
      {/* Header: overall rank */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/15">
          <Trophy className="h-5 w-5 text-amber-300" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold text-white leading-none">
              {getRankEmoji(overallRank)}
            </span>
            <span className="text-sm text-white/50 font-medium">
              / {totalMembers}
            </span>
          </div>
          <p className="text-xs text-white/50 mt-1">Team Ranking</p>
        </div>
        <ChevronRight className="h-4 w-4 text-white/30 group-hover:text-white/70 transition-colors" />
      </div>

      {/* Stat rows */}
      <div className="space-y-1.5">
        {stats.map((stat) => {
          const Icon = stat.icon
          return (
            <div
              key={stat.label}
              className="flex items-center gap-2.5 rounded-lg bg-white/10 px-3 py-2"
            >
              <Icon className={cn("h-4 w-4 shrink-0", stat.color)} />
              <span className="flex-1 text-[13px] text-white/80 font-medium">
                {stat.label}
              </span>
              <span className="text-base leading-none">
                {getRankEmoji(stat.rank)}
              </span>
            </div>
          )
        })}
      </div>
    </button>
  )
}
