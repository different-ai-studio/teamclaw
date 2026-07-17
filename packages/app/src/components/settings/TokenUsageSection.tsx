import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertTriangle, Coins, ChevronLeft, ChevronRight, Trophy } from 'lucide-react'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'
import { formatTokenCount, formatCost } from '@/lib/format-tokens'
import { cn } from '@/lib/utils'
import type { TFunction } from 'i18next'
import type { LiteLlmUsage, LiteLlmUsageRange } from '@/lib/backend/types'

const RANGES: LiteLlmUsageRange[] = ['day', 'week', 'month', 'year']

/** Shift an anchor date by one period (range unit), clamped to "not future". */
function shiftAnchor(anchor: Date, range: LiteLlmUsageRange, dir: -1 | 1): Date {
  const d = new Date(anchor)
  switch (range) {
    case 'day': d.setDate(d.getDate() + dir); break
    case 'week': d.setDate(d.getDate() + dir * 7); break
    case 'month': d.setMonth(d.getMonth() + dir); break
    case 'year': d.setFullYear(d.getFullYear() + dir); break
  }
  return d
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function TokenUsageSection() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)

  // Static references so the i18n dead-key analyzer sees each range label.
  const rangeLabels: Record<LiteLlmUsageRange, string> = {
    day: t('settings.tokenUsage.range.day', 'Day'),
    week: t('settings.tokenUsage.range.week', 'Week'),
    month: t('settings.tokenUsage.range.month', 'Month'),
    year: t('settings.tokenUsage.range.year', 'Year'),
  }

  const [range, setRange] = useState<LiteLlmUsageRange>('month')
  const [anchor, setAnchor] = useState<Date>(() => new Date())
  const [data, setData] = useState<LiteLlmUsage | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  // Stepping back into history is allowed; stepping past the current period is not.
  const isCurrentPeriod = useMemo(() => {
    const next = shiftAnchor(anchor, range, 1)
    return next.getTime() > Date.now()
  }, [anchor, range])

  const load = useCallback(async () => {
    if (!teamId) return
    setIsLoading(true)
    setError(null)
    setUnavailable(false)
    try {
      const usage = await getBackend().teams.getLiteLlmUsage(teamId, { range, date: toIsoDate(anchor) })
      setData(usage)
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code
      if (code === 'litellm_usage_unavailable' || code === 'litellm_unavailable') {
        setUnavailable(true)
        setData(null)
      } else {
        setError((e as Error)?.message ?? String(e))
      }
    } finally {
      setIsLoading(false)
    }
  }, [teamId, range, anchor])

  useEffect(() => { void load() }, [load])

  const budgetPct = useMemo(() => {
    if (!data?.maxBudget || data.maxBudget <= 0) return null
    return Math.min(100, Math.round((data.summary.totalSpend / data.maxBudget) * 100))
  }, [data])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="flex items-center gap-2 text-[15px] font-semibold">
          <Coins className="h-5 w-5 text-muted-foreground" />
          {t('settings.tokenUsage.title', 'Token Usage')}
        </h3>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          {t('settings.tokenUsage.teamDescription', "View the whole team's real AI token consumption and cost.")}
        </p>
      </div>

      {/* Range + period navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-border bg-panel p-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => { setRange(r); setAnchor(new Date()) }}
              className={cn(
                'rounded-md px-3 py-1 text-[12.5px] font-medium transition-colors',
                range === r ? 'bg-selected text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {rangeLabels[r]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAnchor((a) => shiftAnchor(a, range, -1))}
            className="rounded-md border border-border bg-paper p-1.5 text-muted-foreground hover:text-foreground"
            aria-label={t('settings.tokenUsage.prevPeriod', 'Previous period')}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[140px] text-center text-[12.5px] font-medium tabular-nums">
            {data ? (data.startDate === data.endDate ? data.startDate : `${data.startDate} → ${data.endDate}`) : '—'}
          </span>
          <button
            onClick={() => setAnchor((a) => shiftAnchor(a, range, 1))}
            disabled={isCurrentPeriod}
            className="rounded-md border border-border bg-paper p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
            aria-label={t('settings.tokenUsage.nextPeriod', 'Next period')}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* States */}
      {isLoading && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-paper px-4 py-3 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t('settings.tokenUsage.loading', 'Loading stats...')}</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-[13px] text-amber-600 bg-amber-50 dark:bg-amber-950/30 rounded-lg px-4 py-3">
          <AlertTriangle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      )}

      {unavailable && !isLoading && (
        <div className="rounded-lg border border-border bg-panel px-4 py-3 text-[13px] text-muted-foreground">
          {t('settings.tokenUsage.unavailable', 'Team AI usage is not available yet. Enable the team AI gateway (LiteLLM) first.')}
        </div>
      )}

      {data && !unavailable && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <SummaryCard label={t('settings.tokenUsage.totalCost', 'Total Cost')} value={formatCost(data.summary.totalSpend)} highlight />
            <SummaryCard label={t('settings.tokenUsage.totalTokens', 'Total Tokens')} value={formatTokenCount(data.summary.totalTokens)} />
            <SummaryCard label={t('settings.tokenUsage.requests', 'Requests')} value={data.summary.requestCount.toLocaleString()} />
          </div>

          {budgetPct !== null && (
            <div className="space-y-1.5 rounded-lg border border-border bg-paper px-4 py-3">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">{t('settings.tokenUsage.budget', 'Budget')}</span>
                <span className="font-medium tabular-nums">
                  {formatCost(data.summary.totalSpend)} / {formatCost(data.maxBudget ?? 0)} · {budgetPct}%
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-panel">
                <div
                  className={cn('h-full rounded-full', budgetPct >= 90 ? 'bg-red-500' : 'bg-coral')}
                  style={{ width: `${budgetPct}%` }}
                />
              </div>
            </div>
          )}

          {/* Member leaderboard */}
          <div className="rounded-lg border border-border bg-paper">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-[13px] font-semibold">
              <Trophy className="h-4 w-4 text-muted-foreground" />
              {t('settings.tokenUsage.leaderboard', 'Member Leaderboard')}
            </div>
            {data.members.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
                {t('settings.tokenUsage.noUsage', 'No usage in this period.')}
              </div>
            ) : (
              <BreakdownTable
                rows={data.members.map((m, i) => ({
                  // Unattributed is a data-quality notice, not a competitor:
                  // no rank, muted, and the server already sorts it last.
                  rank: m.actorId ? i + 1 : undefined,
                  label: m.displayName ?? t('settings.tokenUsage.unattributed', 'Unattributed'),
                  muted: !m.actorId,
                  key: m.actorId ?? '__unattributed__',
                  tokens: m.tokens,
                  spend: m.spend,
                  requests: m.requests,
                }))}
                t={t}
              />
            )}
          </div>

          {/* By model */}
          {data.byModel.length > 0 && (
            <div className="rounded-lg border border-border bg-paper">
              <div className="border-b border-border px-4 py-2.5 text-[13px] font-semibold">
                {t('settings.tokenUsage.byModel', 'By Model')}
              </div>
              <BreakdownTable
                rows={data.byModel.map((m) => ({
                  label: m.model,
                  tokens: m.tokens,
                  spend: m.spend,
                  requests: m.requests,
                }))}
                t={t}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SummaryCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={cn('rounded-lg border border-border bg-paper px-4 py-3', highlight && 'bg-selected/60')}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
    </div>
  )
}

type Row = { rank?: number; label: string; tokens: number; spend: number; requests: number; muted?: boolean; key?: string }

function BreakdownTable({ rows, t }: { rows: Row[]; t: TFunction }) {
  return (
    <div className="divide-y divide-border">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>{t('settings.tokenUsage.colName', 'Name')}</span>
        <span className="text-right">{t('settings.tokenUsage.colTokens', 'Tokens')}</span>
        <span className="text-right">{t('settings.tokenUsage.colRequests', 'Reqs')}</span>
        <span className="text-right">{t('settings.tokenUsage.colCost', 'Cost')}</span>
      </div>
      {rows.map((r, i) => (
        <div key={r.key ?? `${r.label}-${i}`} className={cn('grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-4 py-2 text-[12.5px]', r.muted && 'text-muted-foreground')}>
          <span className="flex items-center gap-2 truncate">
            {r.rank != null && (
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-panel text-[11px] font-medium tabular-nums text-muted-foreground">
                {r.rank}
              </span>
            )}
            <span className="truncate">{r.label}</span>
          </span>
          <span className="text-right tabular-nums">{formatTokenCount(r.tokens)}</span>
          <span className="text-right tabular-nums text-muted-foreground">{r.requests.toLocaleString()}</span>
          <span className="text-right font-medium tabular-nums">{formatCost(r.spend)}</span>
        </div>
      ))}
    </div>
  )
}
