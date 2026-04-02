/**
 * KnowledgeExplorer - shows distilled experiences, strategies, and skills
 * accumulated by the super-agent network. Polls every 10 seconds.
 */
import * as React from 'react'
import { cn } from '@/lib/utils'
import { useSuperAgentStore } from '@/stores/super-agent'
import type { Experience, ExperienceOutcome, Strategy, StrategyType, DistilledSkill, ValidationStatus } from '@/stores/super-agent'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// ─── Outcome Badge ────────────────────────────────────────────────────────────

function outcomeBadgeClass(outcome: ExperienceOutcome): string {
  switch (outcome) {
    case 'success':
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    case 'failure':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    case 'partial':
      return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

// ─── Strategy Type Badge ──────────────────────────────────────────────────────

function strategyTypeBadgeClass(type: StrategyType): string {
  switch (type) {
    case 'recommend':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
    case 'avoid':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    case 'compare':
      return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

// ─── Validation Status Dot ────────────────────────────────────────────────────

function validationDotClass(status: ValidationStatus): string {
  switch (status) {
    case 'validated':
      return 'bg-green-500'
    case 'deprecated':
      return 'bg-red-500'
    case 'testing':
      return 'bg-blue-400'
    case 'proposed':
    default:
      return 'bg-yellow-400'
  }
}

// ─── Record Experience Form ───────────────────────────────────────────────────

function RecordExperienceForm({ onClose }: { onClose: () => void }) {
  const recordExperience = useSuperAgentStore((s) => s.recordExperience)
  const [taskId, setTaskId] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!taskId.trim()) return
    setSubmitting(true)
    await recordExperience(taskId.trim())
    setSubmitting(false)
    onClose()
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border bg-card p-4 space-y-3">
      <p className="text-sm font-medium">Record Experience from Task</p>
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Task ID</label>
        <Input
          placeholder="Enter task ID…"
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
          required
        />
      </div>
      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" disabled={submitting || !taskId.trim()}>
          {submitting ? 'Recording…' : 'Record'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

// ─── Validate Strategy Form ───────────────────────────────────────────────────

function ValidateStrategyForm({
  strategyId,
  onClose,
}: {
  strategyId: string
  onClose: () => void
}) {
  const validateStrategy = useSuperAgentStore((s) => s.validateStrategy)
  const [score, setScore] = React.useState(0.75)
  const [submitting, setSubmitting] = React.useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    await validateStrategy(strategyId, score)
    setSubmitting(false)
    onClose()
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 rounded-lg border bg-muted/40 p-3 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Validate Strategy</p>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Score</label>
          <span className="text-xs font-medium">{score.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={score}
          onChange={(e) => setScore(parseFloat(e.target.value))}
          className="w-full accent-primary"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={submitting}>
          {submitting ? 'Validating…' : 'Submit'}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

// ─── Experience Card ──────────────────────────────────────────────────────────

function ExperienceCard({ experience }: { experience: Experience }) {
  const shortId = experience.id.slice(0, 8)

  return (
    <div className="rounded-xl border bg-card p-4 transition-all">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-xs leading-none font-medium',
              outcomeBadgeClass(experience.outcome),
            )}
          >
            {experience.outcome}
          </span>
          <span className="text-xs text-muted-foreground">{experience.domain}</span>
          <span className="ml-auto font-mono text-xs text-muted-foreground/60">
            #{shortId}
          </span>
        </div>

        <p className="text-sm leading-snug line-clamp-2">{experience.context}</p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Score: <span className="font-medium">{experience.metrics.score}</span></span>
          <span>Tokens: <span className="font-medium">{experience.metrics.tokensUsed}</span></span>
          <span>{Math.round(experience.metrics.duration / 1000)}s</span>
        </div>
      </div>
    </div>
  )
}

// ─── Strategy Card ────────────────────────────────────────────────────────────

function StrategyCard({ strategy }: { strategy: Strategy }) {
  const shortId = strategy.id.slice(0, 8)
  const successPct = Math.round(strategy.successRate * 100)
  const canValidate =
    strategy.validation.status === 'proposed' || strategy.validation.status === 'testing'
  const [showValidateForm, setShowValidateForm] = React.useState(false)

  return (
    <div className="rounded-xl border bg-card p-4 transition-all">
      <div className="flex items-start gap-3">
        {/* Validation status dot */}
        <div className="mt-1.5 flex-shrink-0">
          <span
            className={cn('block h-2.5 w-2.5 rounded-full', validationDotClass(strategy.validation.status))}
            title={strategy.validation.status}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-xs leading-none font-medium',
                strategyTypeBadgeClass(strategy.strategyType),
              )}
            >
              {strategy.strategyType}
            </span>
            <span className="text-xs text-muted-foreground">{strategy.domain}</span>
            <span className="ml-auto font-mono text-xs text-muted-foreground/60">
              #{shortId}
            </span>
          </div>

          <p className="text-sm leading-snug">{strategy.recommendation}</p>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>Success: <span className="font-medium">{successPct}%</span></span>
            <span>Samples: <span className="font-medium">{strategy.sampleSize}</span></span>
          </div>

          {canValidate && !showValidateForm && (
            <div className="pt-1">
              <Button size="xs" variant="outline" onClick={() => setShowValidateForm(true)}>
                Validate
              </Button>
            </div>
          )}

          {showValidateForm && (
            <ValidateStrategyForm
              strategyId={strategy.id}
              onClose={() => setShowValidateForm(false)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Skill Card ───────────────────────────────────────────────────────────────

function SkillCard({ skill }: { skill: DistilledSkill }) {
  const effectivenessPct = Math.round(skill.avgEffectiveness * 100)

  return (
    <div className="rounded-xl border bg-card p-4 transition-all">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{skill.name}</span>
        </div>

        <p className="text-sm text-muted-foreground leading-snug">{skill.skillContent}</p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Effectiveness: <span className="font-medium">{effectivenessPct}%</span></span>
          <span>Adopted: <span className="font-medium">{skill.adoptionCount}x</span></span>
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function KnowledgeExplorer() {
  const knowledge = useSuperAgentStore((s) => s.knowledge)
  const fetchKnowledge = useSuperAgentStore((s) => s.fetchKnowledge)
  const [showRecordForm, setShowRecordForm] = React.useState(false)

  React.useEffect(() => {
    fetchKnowledge()
    const id = setInterval(fetchKnowledge, 10_000)
    return () => clearInterval(id)
  }, [fetchKnowledge])

  const { experiences, strategies, distilledSkills } = knowledge

  return (
    <div className="space-y-8">
      {/* Experiences */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Experiences</p>
            {experiences.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {experiences.length} recorded
              </p>
            )}
          </div>
          {!showRecordForm && (
            <Button size="xs" variant="outline" onClick={() => setShowRecordForm(true)}>
              Record from Task
            </Button>
          )}
        </div>

        {showRecordForm && (
          <RecordExperienceForm onClose={() => setShowRecordForm(false)} />
        )}

        {experiences.length === 0 ? (
          <div className="rounded-xl border bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground">No experiences recorded</p>
          </div>
        ) : (
          <div className="space-y-2">
            {experiences.map((exp) => (
              <ExperienceCard key={exp.id} experience={exp} />
            ))}
          </div>
        )}
      </div>

      {/* Strategies */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Strategies</p>
            {strategies.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {strategies.length} distilled
              </p>
            )}
          </div>
        </div>

        {strategies.length === 0 ? (
          <div className="rounded-xl border bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground">No strategies distilled</p>
          </div>
        ) : (
          <div className="space-y-2">
            {strategies.map((strategy) => (
              <StrategyCard key={strategy.id} strategy={strategy} />
            ))}
          </div>
        )}
      </div>

      {/* Skills */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Skills</p>
            {distilledSkills.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {distilledSkills.length} available
              </p>
            )}
          </div>
        </div>

        {distilledSkills.length === 0 ? (
          <div className="rounded-xl border bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground">No skills distilled</p>
          </div>
        ) : (
          <div className="space-y-2">
            {distilledSkills.map((skill) => (
              <SkillCard key={skill.id} skill={skill} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
