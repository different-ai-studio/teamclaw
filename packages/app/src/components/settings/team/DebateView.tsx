/**
 * DebateView - visualizes the 3-phase deliberation pipeline:
 * 1. Perspectives  – angle badges, positions, confidence
 * 2. Rounds        – rebuttals with stance badges
 * 3. Voting        – candidate options, tally, winner, margin, dissent
 */
import * as React from 'react'
import { cn } from '@/lib/utils'
import { useSuperAgentStore } from '@/stores/super-agent'
import type {
  DebateRecord,
  DebateStatus,
  RebuttalStance,
  Perspective,
  Rebuttal,
  DebateRound,
  CandidateOption,
  Vote,
  SynthesisResult,
} from '@/stores/super-agent'

// ─── Status Badge ─────────────────────────────────────────────────────────────

function debateStatusClass(status: DebateStatus): string {
  switch (status) {
    case 'gathering_perspectives':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
    case 'debating':
      return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
    case 'voting':
      return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
    case 'concluded':
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

// ─── Rebuttal Stance Badge ────────────────────────────────────────────────────

function stanceBadgeClass(stance: RebuttalStance): string {
  switch (stance) {
    case 'agree':
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    case 'disagree':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    case 'partially_agree':
      return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

// ─── Phase 1: Perspectives ────────────────────────────────────────────────────

interface PerspectiveListProps {
  perspectives: Perspective[]
}

function PerspectiveList({ perspectives }: PerspectiveListProps) {
  if (perspectives.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center">
        <p className="text-sm text-muted-foreground">No perspectives submitted yet</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {perspectives.map((p, i) => (
        <div key={`${p.agentId}-${i}`} className="rounded-xl border bg-card p-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {p.angle}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {Math.round(p.confidence * 100)}% confidence
                </span>
              </div>
              <p className="text-sm leading-snug">{p.position}</p>
              <p className="text-xs text-muted-foreground truncate">
                Agent: <span className="font-medium">{p.agentId.slice(0, 12)}</span>
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Phase 2: Debate Rounds ───────────────────────────────────────────────────

interface RebuttalItemProps {
  rebuttal: Rebuttal
}

function RebuttalItem({ rebuttal }: RebuttalItemProps) {
  return (
    <div className="rounded-lg border bg-card/60 p-3 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-xs leading-none font-medium',
            stanceBadgeClass(rebuttal.response),
          )}
        >
          {rebuttal.response}
        </span>
        <span className="text-xs text-muted-foreground">
          → <span className="font-medium">{rebuttal.targetAgentId.slice(0, 10)}</span>
        </span>
      </div>
      <p className="text-sm leading-snug">{rebuttal.argument}</p>
    </div>
  )
}

interface RoundCardProps {
  round: DebateRound
}

function RoundCard({ round }: RoundCardProps) {
  const allRebuttals = round.responses.flatMap((r) => r.rebuttals)

  return (
    <div className="rounded-xl border bg-card p-4 space-y-3">
      <p className="text-xs font-medium text-muted-foreground">
        Round {round.round}
      </p>

      {allRebuttals.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Rebuttals</p>
          <div className="space-y-2">
            {allRebuttals.map((r, i) => (
              <RebuttalItem key={`${r.targetAgentId}-${i}`} rebuttal={r} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Phase 3: Voting ──────────────────────────────────────────────────────────

interface VotingPanelProps {
  candidates: CandidateOption[]
  votes: Vote[]
  synthesis: SynthesisResult | null
}

function VotingPanel({ candidates, votes, synthesis }: VotingPanelProps) {
  // Build tally: count rank-1 votes per option
  const tally = new Map<string, number>()
  for (const candidate of candidates) {
    tally.set(candidate.id, 0)
  }
  for (const vote of votes) {
    const topRanking = vote.ranking.reduce(
      (best, r) => (r.rank < best.rank ? r : best),
      vote.ranking[0],
    )
    if (topRanking) {
      tally.set(topRanking.optionId, (tally.get(topRanking.optionId) ?? 0) + 1)
    }
  }

  if (candidates.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center">
        <p className="text-sm text-muted-foreground">No candidate options yet</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {candidates.map((candidate) => {
        const voteCount = tally.get(candidate.id) ?? 0
        const isWinner = synthesis?.winningOptionId === candidate.id

        return (
          <div
            key={candidate.id}
            className={cn(
              'rounded-xl border bg-card p-4 space-y-2 transition-all',
              isWinner && 'border-green-500/50 bg-green-50/30 dark:bg-green-900/10',
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              {isWinner && (
                <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700 leading-none dark:bg-green-900/30 dark:text-green-400">
                  winner
                </span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {voteCount} vote{voteCount !== 1 ? 's' : ''}
              </span>
            </div>
            <p className="text-sm leading-snug">{candidate.description}</p>
          </div>
        )
      })}

      {synthesis && (
        <div className="rounded-xl border bg-card p-4 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Synthesis</p>
          <p className="text-sm leading-snug">{synthesis.winningDescription}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Margin: <span className="font-medium">{Math.round(synthesis.margin * 100)}%</span>
            </span>
            {synthesis.dissent.length > 0 && (
              <span>
                Dissent: <span className="font-medium">{synthesis.dissent.join(', ')}</span>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Debate Card ──────────────────────────────────────────────────────────────

interface DebateCardProps {
  debate: DebateRecord
}

function DebateCard({ debate }: DebateCardProps) {
  const [expanded, setExpanded] = React.useState(false)

  return (
    <div className="rounded-xl border bg-card transition-all">
      {/* Header */}
      <button
        type="button"
        className="w-full p-4 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-start gap-2">
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-xs leading-none font-medium shrink-0',
                debateStatusClass(debate.status),
              )}
            >
              {debate.status}
            </span>
            <span className="text-xs text-muted-foreground">
              {debate.perspectives.length} perspective{debate.perspectives.length !== 1 ? 's' : ''}
            </span>
            {debate.outcome?.actualResult && (
              <span className="ml-auto text-xs font-medium text-green-600 dark:text-green-400 truncate max-w-[180px]">
                {debate.outcome.actualResult}
              </span>
            )}
          </div>
          <p className="text-sm font-medium leading-snug">{debate.question}</p>
          {debate.requestedAngles.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {debate.requestedAngles.map((angle) => (
                <span
                  key={angle}
                  className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {angle}
                </span>
              ))}
            </div>
          )}
        </div>
      </button>

      {/* Expanded body: 3 phases */}
      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-6">
          {/* Phase 1: Perspectives */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Perspectives
            </p>
            <PerspectiveList perspectives={debate.perspectives} />
          </div>

          {/* Phase 2: Rounds */}
          {debate.rounds.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Rounds
              </p>
              <div className="space-y-2">
                {debate.rounds.map((round) => (
                  <RoundCard key={round.round} round={round} />
                ))}
              </div>
            </div>
          )}

          {/* Phase 3: Voting */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Voting
            </p>
            <VotingPanel
              candidates={debate.candidateOptions}
              votes={debate.votes}
              synthesis={debate.synthesis}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function DebateView() {
  const debates = useSuperAgentStore((s) => s.debates)
  const fetchDebates = useSuperAgentStore((s) => s.fetchDebates)

  React.useEffect(() => {
    fetchDebates()
    const id = setInterval(fetchDebates, 5000)
    return () => clearInterval(id)
  }, [fetchDebates])

  const activeDebates = debates.debates.filter(
    (d) => d.status === 'gathering_perspectives' || d.status === 'debating' || d.status === 'voting',
  )
  const concludedDebates = debates.debates.filter(
    (d) => d.status === 'concluded',
  )

  return (
    <div className="space-y-6">
      {/* Active deliberations */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Active Deliberations</p>
            {activeDebates.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {activeDebates.length} debate{activeDebates.length !== 1 ? 's' : ''} in progress
              </p>
            )}
          </div>
        </div>

        {activeDebates.length === 0 ? (
          <div className="rounded-xl border bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground">No active deliberations</p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeDebates.map((debate) => (
              <DebateCard key={debate.id} debate={debate} />
            ))}
          </div>
        )}
      </div>

      {/* Concluded */}
      {concludedDebates.length > 0 && (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Concluded</p>
          </div>
          <div className="space-y-2">
            {concludedDebates.map((debate) => (
              <DebateCard key={debate.id} debate={debate} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
