/**
 * DebateView - visualizes the 3-phase deliberation pipeline:
 * 1. Perspectives  – angle badges, positions, confidence
 * 2. Rounds        – rebuttals with stance badges
 * 3. Voting        – candidate options, tally, winner, margin, dissent
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn, isTauri } from '@/lib/utils'
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
  VoteRanking,
  Angle,
} from '@/stores/super-agent'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'

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

// ─── All available angles ─────────────────────────────────────────────────────

const ALL_ANGLES: Angle[] = [
  'feasibility',
  'performance',
  'security',
  'maintainability',
  'user_experience',
  'cost',
  'risk',
]

// ─── Start Deliberation Form ──────────────────────────────────────────────────

function StartDeliberationForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const startDeliberation = useSuperAgentStore((s) => s.startDeliberation)
  const [question, setQuestion] = React.useState('')
  const [context, setContext] = React.useState('')
  const [selectedAngles, setSelectedAngles] = React.useState<Angle[]>([])
  const [submitting, setSubmitting] = React.useState(false)

  function toggleAngle(angle: Angle) {
    setSelectedAngles((prev) =>
      prev.includes(angle) ? prev.filter((a) => a !== angle) : [...prev, angle],
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!question.trim()) return
    setSubmitting(true)
    await startDeliberation(question.trim(), context.trim(), selectedAngles)
    setSubmitting(false)
    onClose()
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border bg-card p-4 space-y-3">
      <p className="text-sm font-medium">{t('settings.superAgent.debate.newDeliberation')}</p>

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">{t('settings.superAgent.debate.question')}</label>
        <Textarea
          placeholder={t('settings.superAgent.debate.questionPlaceholder')}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          className="min-h-[60px]"
          required
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">{t('settings.superAgent.debate.context')}</label>
        <Textarea
          placeholder={t('settings.superAgent.debate.contextPlaceholder')}
          value={context}
          onChange={(e) => setContext(e.target.value)}
          className="min-h-[52px]"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">{t('settings.superAgent.debate.angles')}</label>
        <div className="flex flex-wrap gap-1.5">
          {ALL_ANGLES.map((angle) => (
            <button
              key={angle}
              type="button"
              onClick={() => toggleAngle(angle)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
                selectedAngles.includes(angle)
                  ? 'bg-primary text-primary-foreground border-transparent'
                  : 'border-border bg-transparent text-muted-foreground hover:bg-muted',
              )}
            >
              {angle}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" disabled={submitting || !question.trim()}>
          {submitting ? t('settings.superAgent.debate.starting') : t('settings.superAgent.debate.startDeliberation')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}

// ─── Add Perspective Form ─────────────────────────────────────────────────────

function AddPerspectiveForm({
  debateId,
  onClose,
}: {
  debateId: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const submitPerspective = useSuperAgentStore((s) => s.submitPerspective)
  const [angle, setAngle] = React.useState<Angle>(ALL_ANGLES[0])
  const [position, setPosition] = React.useState('')
  const [reasoning, setReasoning] = React.useState('')
  const [confidence, setConfidence] = React.useState(0.7)
  const [submitting, setSubmitting] = React.useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!position.trim()) return
    setSubmitting(true)
    await submitPerspective(debateId, angle, position.trim(), confidence, reasoning.trim())
    setSubmitting(false)
    onClose()
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border bg-muted/40 p-3 space-y-3 mt-2">
      <p className="text-xs font-medium text-muted-foreground">{t('settings.superAgent.debate.addPerspective')}</p>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t('settings.superAgent.debate.angle')}</label>
        <div className="flex flex-wrap gap-1">
          {ALL_ANGLES.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAngle(a)}
              className={cn(
                'rounded px-2 py-0.5 text-xs border transition-colors',
                angle === a
                  ? 'bg-primary text-primary-foreground border-transparent'
                  : 'border-border bg-transparent text-muted-foreground hover:bg-muted',
              )}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t('settings.superAgent.debate.position')}</label>
        <Textarea
          placeholder={t('settings.superAgent.debate.positionPlaceholder')}
          value={position}
          onChange={(e) => setPosition(e.target.value)}
          className="min-h-[52px]"
          required
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t('settings.superAgent.debate.reasoning')}</label>
        <Textarea
          placeholder={t('settings.superAgent.debate.reasoningPlaceholder')}
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          className="min-h-[40px]"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">{t('settings.superAgent.debate.confidence')}</label>
          <span className="text-xs font-medium">{Math.round(confidence * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={confidence}
          onChange={(e) => setConfidence(parseFloat(e.target.value))}
          className="w-full accent-primary"
        />
      </div>

      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={submitting || !position.trim()}>
          {submitting ? t('settings.superAgent.debate.submitting') : t('settings.superAgent.debate.submit')}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}

// ─── Cast Vote Form ───────────────────────────────────────────────────────────

function CastVoteForm({
  debateId,
  candidates,
  onClose,
}: {
  debateId: string
  candidates: CandidateOption[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const submitVote = useSuperAgentStore((s) => s.submitVote)
  const [ranks, setRanks] = React.useState<Record<string, number>>(
    Object.fromEntries(candidates.map((c, i) => [c.id, i + 1])),
  )
  const [reasoning, setReasoning] = React.useState('')
  const [confidence, setConfidence] = React.useState(0.7)
  const [submitting, setSubmitting] = React.useState(false)

  function updateRank(id: string, val: string) {
    const num = parseInt(val, 10)
    if (!isNaN(num) && num >= 1) {
      setRanks((prev) => ({ ...prev, [id]: num }))
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (candidates.length === 0) return
    setSubmitting(true)

    // The top-ranked option (rank=1) is preferred
    const ranking: VoteRanking[] = candidates.map((c) => ({
      optionId: c.id,
      rank: ranks[c.id] ?? 999,
    }))
    const preferred = ranking.reduce((best, r) => (r.rank < best.rank ? r : best))

    await submitVote(debateId, preferred.optionId, ranking, confidence, reasoning.trim())
    setSubmitting(false)
    onClose()
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border bg-muted/40 p-3 space-y-3 mt-2">
      <p className="text-xs font-medium text-muted-foreground">{t('settings.superAgent.debate.castVote')}</p>

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">{t('settings.superAgent.debate.rankCandidates')}</label>
        {candidates.map((c) => (
          <div key={c.id} className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              value={ranks[c.id] ?? ''}
              onChange={(e) => updateRank(c.id, e.target.value)}
              className="w-14 text-center"
            />
            <p className="text-xs text-muted-foreground line-clamp-1 flex-1">{c.description}</p>
          </div>
        ))}
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">{t('settings.superAgent.debate.confidence')}</label>
          <span className="text-xs font-medium">{Math.round(confidence * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={confidence}
          onChange={(e) => setConfidence(parseFloat(e.target.value))}
          className="w-full accent-primary"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t('settings.superAgent.debate.finalReasoning')}</label>
        <Textarea
          placeholder={t('settings.superAgent.debate.finalReasoningPlaceholder')}
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          className="min-h-[40px]"
        />
      </div>

      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={submitting || candidates.length === 0}>
          {submitting ? t('settings.superAgent.debate.casting') : t('settings.superAgent.debate.castVote')}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}

// ─── Phase 1: Perspectives ────────────────────────────────────────────────────

interface PerspectiveListProps {
  perspectives: Perspective[]
}

function PerspectiveList({ perspectives }: PerspectiveListProps) {
  const { t } = useTranslation()

  if (perspectives.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center">
        <p className="text-sm text-muted-foreground">{t('settings.superAgent.debate.noPerspectives')}</p>
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
                  {Math.round(p.confidence * 100)}% {t('settings.superAgent.debate.confidence').toLowerCase()}
                </span>
              </div>
              <p className="text-sm leading-snug">{p.position}</p>
              <p className="text-xs text-muted-foreground truncate">
                {t('settings.superAgent.debate.agent')}: <span className="font-medium">{p.agentId.slice(0, 12)}</span>
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
  const { t } = useTranslation()
  const allRebuttals = round.responses.flatMap((r) => r.rebuttals)

  return (
    <div className="rounded-xl border bg-card p-4 space-y-3">
      <p className="text-xs font-medium text-muted-foreground">
        {t('settings.superAgent.debate.round', { number: round.round })}
      </p>

      {allRebuttals.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('settings.superAgent.debate.rebuttals')}</p>
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
  const { t } = useTranslation()

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
        <p className="text-sm text-muted-foreground">{t('settings.superAgent.debate.noCandidates')}</p>
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
                  {t('settings.superAgent.debate.winner')}
                </span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {t('settings.superAgent.debate.voteCount', { count: voteCount })}
              </span>
            </div>
            <p className="text-sm leading-snug">{candidate.description}</p>
          </div>
        )
      })}

      {synthesis && (
        <div className="rounded-xl border bg-card p-4 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">{t('settings.superAgent.debate.synthesis')}</p>
          <p className="text-sm leading-snug">{synthesis.winningDescription}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {t('settings.superAgent.debate.margin')}: <span className="font-medium">{Math.round(synthesis.margin * 100)}%</span>
            </span>
            {synthesis.dissent.length > 0 && (
              <span>
                {t('settings.superAgent.debate.dissent')}: <span className="font-medium">{synthesis.dissent.join(', ')}</span>
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
  onRefresh: () => void
}

function DebateCard({ debate, onRefresh }: DebateCardProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = React.useState(false)
  const [showPerspectiveForm, setShowPerspectiveForm] = React.useState(false)
  const [showVoteForm, setShowVoteForm] = React.useState(false)
  const [concluding, setConcluding] = React.useState(false)

  const canAddPerspective = debate.status === 'gathering_perspectives'
  const canVote = debate.status === 'voting'
  const canConclude = debate.votes.length > 0 && debate.status !== 'concluded'

  async function handleConclude() {
    if (!isTauri()) return
    setConcluding(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('super_agent_conclude_deliberation', { debateId: debate.id })
      onRefresh()
    } catch (err) {
      console.warn('[SuperAgent] Failed to conclude deliberation:', err)
    } finally {
      setConcluding(false)
    }
  }

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
              {t(`settings.superAgent.debate.status.${debate.status}`)}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('settings.superAgent.debate.perspectiveCount', { count: debate.perspectives.length })}
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

      {/* Expanded body: 3 phases + action buttons */}
      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-6">
          {/* Action buttons */}
          {(canAddPerspective || canVote || canConclude) && (
            <div className="flex flex-wrap gap-2">
              {canAddPerspective && !showPerspectiveForm && (
                <Button size="xs" variant="outline" onClick={() => setShowPerspectiveForm(true)}>
                  {t('settings.superAgent.debate.addPerspective')}
                </Button>
              )}
              {canVote && !showVoteForm && debate.candidateOptions.length > 0 && (
                <Button size="xs" variant="outline" onClick={() => setShowVoteForm(true)}>
                  {t('settings.superAgent.debate.castVote')}
                </Button>
              )}
              {canConclude && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={handleConclude}
                  disabled={concluding}
                >
                  {concluding ? t('settings.superAgent.debate.concluding') : t('settings.superAgent.debate.conclude')}
                </Button>
              )}
            </div>
          )}

          {showPerspectiveForm && (
            <AddPerspectiveForm
              debateId={debate.id}
              onClose={() => setShowPerspectiveForm(false)}
            />
          )}

          {showVoteForm && (
            <CastVoteForm
              debateId={debate.id}
              candidates={debate.candidateOptions}
              onClose={() => setShowVoteForm(false)}
            />
          )}

          {/* Phase 1: Perspectives */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('settings.superAgent.debate.perspectives')}
            </p>
            <PerspectiveList perspectives={debate.perspectives} />
          </div>

          {/* Phase 2: Rounds */}
          {debate.rounds.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('settings.superAgent.debate.rounds')}
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
              {t('settings.superAgent.debate.voting')}
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
  const { t } = useTranslation()
  const debates = useSuperAgentStore((s) => s.debates)
  const fetchDebates = useSuperAgentStore((s) => s.fetchDebates)
  const [showStartForm, setShowStartForm] = React.useState(false)

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
      {/* Start Deliberation form / button */}
      <div className="space-y-3">
        {showStartForm ? (
          <StartDeliberationForm onClose={() => setShowStartForm(false)} />
        ) : (
          <Button size="sm" onClick={() => setShowStartForm(true)}>
            {t('settings.superAgent.debate.startDeliberation')}
          </Button>
        )}
      </div>

      {/* Active deliberations */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t('settings.superAgent.debate.activeDeliberations')}</p>
            {activeDebates.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('settings.superAgent.debate.activeCount', { count: activeDebates.length })}
              </p>
            )}
          </div>
        </div>

        {activeDebates.length === 0 ? (
          <div className="rounded-xl border bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground">{t('settings.superAgent.debate.noActiveDeliberations')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeDebates.map((debate) => (
              <DebateCard key={debate.id} debate={debate} onRefresh={fetchDebates} />
            ))}
          </div>
        )}
      </div>

      {/* Concluded */}
      {concludedDebates.length > 0 && (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{t('settings.superAgent.debate.concluded')}</p>
          </div>
          <div className="space-y-2">
            {concludedDebates.map((debate) => (
              <DebateCard key={debate.id} debate={debate} onRefresh={fetchDebates} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
