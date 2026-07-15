import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Trophy, Flame, MessageSquareHeart, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TEAM_SYNCED_EVENT } from '@/lib/build-config'
import { buildSharedRankMap } from '@/lib/team-leaderboard-ranks'
import { useTeamShareStore, isShareModeLocked } from '@/stores/team-share'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useAuthStore } from '@/stores/auth-store'
import { fetchTeamLeaderboard } from '@/lib/telemetry/cloud-leaderboard'
import { resolveCurrentMemberActorId } from '@/lib/current-actor'
import type { TeamLeaderboard } from '@/components/settings/LeaderboardSection'

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
  const { t } = useTranslation()
  const [leaderboard, setLeaderboard] = React.useState<TeamLeaderboard | null>(null)
  const [currentActorId, setCurrentActorId] = React.useState<string | null>(null)
  const teamShareActive = useTeamShareStore((s) => isShareModeLocked(s.status.mode))

  React.useEffect(() => {
    const load = async () => {
      const teamId = useCurrentTeamStore.getState().team?.id
      if (!teamId) return
      try {
        const leaderboardResult = await fetchTeamLeaderboard(teamId, "week")
        setLeaderboard(leaderboardResult)
        const userId = useAuthStore.getState().session?.user?.id
        if (userId) {
          const actorId = await resolveCurrentMemberActorId(teamId, userId)
          if (actorId) {
            setCurrentActorId(actorId)
          }
        }
      } catch {
        // Ignore errors
      }
    }
    load()

    const handler = () => { load() }
    window.addEventListener(TEAM_SYNCED_EVENT, handler)
    return () => window.removeEventListener(TEAM_SYNCED_EVENT, handler)
  }, [])

  // Clear leaderboard data when team mode is disabled
  React.useEffect(() => {
    if (!teamShareActive) {
      setLeaderboard(null)
      setCurrentActorId(null)
    }
  }, [teamShareActive])

  // Calculate current user's rank
  const currentMember = React.useMemo(() => {
    if (!leaderboard?.members || !currentActorId) return null
    return leaderboard.members.find((m) => m.memberId === currentActorId)
  }, [leaderboard, currentActorId])

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

    const tokenRanks = buildSharedRankMap({
      items: membersWithAggregated,
      getKey: (member) => member.memberId,
      getScore: (member) => member.aggregated.totalTokens,
    })
    const feedbackRanks = buildSharedRankMap({
      items: membersWithAggregated,
      getKey: (member) => member.memberId,
      getScore: (member) => member.aggregated.totalFeedbacks,
    })

    // Overall rank is still based on the average metric rank, but tied averages now share the same place.
    const memberRanks = membersWithAggregated.map((member) => ({
      memberId: member.memberId,
      avgRank: ((tokenRanks.get(member.memberId) ?? 0) + (feedbackRanks.get(member.memberId) ?? 0)) / 2,
    }))
    const overallRanks = buildSharedRankMap({
      items: memberRanks,
      getKey: (member) => member.memberId,
      getScore: (member) => member.avgRank,
      direction: 'asc',
    })

    const currentMemberKey = currentActorId ?? ''
    const tokenRank = tokenRanks.get(currentMemberKey) ?? 0
    const feedbackRank = feedbackRanks.get(currentMemberKey) ?? 0
    const overallRank = overallRanks.get(currentMemberKey) ?? 0

    return {
      tokenRank,
      feedbackRank,
      overallRank,
      totalMembers: leaderboard.members.length,
    }
  }, [leaderboard, currentMember, currentActorId])

  const { overallRank, totalMembers, tokenRank, feedbackRank } = ranks

  const stats = [
    { label: t('settings.leaderboard.tokenUsage', 'Token Usage'), rank: tokenRank, icon: Flame },
    { label: t('settings.leaderboard.feedbackCount', 'Feedback Count'), rank: feedbackRank, icon: MessageSquareHeart },
  ]

  if (totalMembers === 0) {
    return (
      <button
        onClick={onClick}
        className={cn(
          "w-full rounded-[14px] border border-border bg-paper p-4 text-left transition-colors",
          "hover:bg-selected/60",
          "group cursor-pointer",
        )}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-panel">
            <Trophy className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-foreground">{t('settings.leaderboard.teamRanking', 'Team Ranking')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.leaderboard.clickToView', 'Click to view')}</p>
          </div>
          <ChevronRight className="h-4 w-4 text-faint transition-colors group-hover:text-foreground" />
        </div>
      </button>
    )
  }

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full rounded-[14px] border border-border bg-paper p-4 text-left transition-colors",
        "hover:bg-selected/60",
        "group cursor-pointer",
      )}
    >
      {/* Header: overall rank */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-panel">
          <Trophy className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1">
            <span className="text-[20px] font-semibold leading-none text-foreground">
              {getRankEmoji(overallRank)}
            </span>
            <span className="font-mono text-xs text-faint">
              / {totalMembers}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.leaderboard.teamRanking', 'Team Ranking')}</p>
        </div>
        <ChevronRight className="h-4 w-4 text-faint transition-colors group-hover:text-foreground" />
      </div>

      {/* Stat rows */}
      <div className="space-y-1.5">
        {stats.map((stat) => {
          const Icon = stat.icon
          return (
            <div
              key={stat.label}
              className="flex items-center gap-2.5 rounded-lg bg-panel px-3 py-2"
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 text-[13px] font-medium text-ink-2">
                {stat.label}
              </span>
              <span className="text-base leading-none text-foreground">
                {getRankEmoji(stat.rank)}
              </span>
            </div>
          )
        })}
      </div>
    </button>
  )
}
