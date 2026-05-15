import { useTranslation } from 'react-i18next'
import { Loader2, AlertTriangle, Coins } from 'lucide-react'
import { useLocalStatsStore } from '@/stores/local-stats'
import { formatTokenCount, formatCost } from '@/lib/format-tokens'
import { cn } from '@/lib/utils'
import { TEAMCLAW_DIR } from '@/lib/build-config'


export function TokenUsageSection() {
  const { t } = useTranslation()
  const stats = useLocalStatsStore((s) => s.stats)
  const isLoading = useLocalStatsStore((s) => s.isLoading)
  const error = useLocalStatsStore((s) => s.error)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="flex items-center gap-2 text-[15px] font-semibold">
          <Coins className="h-5 w-5 text-muted-foreground" />
          {t('settings.tokenUsage.title', 'Token Usage')}
        </h3>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          {t('settings.tokenUsage.description', 'View token consumption and cost for this workspace.')}
        </p>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-paper px-4 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t('settings.tokenUsage.loading', 'Loading stats...')}</span>
        </div>
      )}

      {/* Error warning */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 dark:bg-amber-950/30 rounded-lg px-4 py-3">
          <AlertTriangle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      )}

      {/* Stats info banner */}
      <div className="rounded-lg border border-border bg-panel px-4 py-2.5">
        <p className="text-xs text-muted-foreground">
          {t('settings.tokenUsage.statsBanner', { defaultValue: 'Data is read from {{teamclawDir}}/stats.json in your workspace. Stats update automatically as you work.', teamclawDir: TEAMCLAW_DIR })}
        </p>
      </div>

      {/* Global summary */}
      {stats && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <SummaryCard 
              label={t('settings.tokenUsage.totalCost', 'Total Cost')} 
              value={formatCost(stats.totalCost)} 
              highlight 
            />
            <SummaryCard 
              label={t('settings.tokenUsage.totalTokens', 'Total Tokens')} 
              value={formatTokenCount(stats.totalTokens)} 
            />
            <SummaryCard 
              label={t('settings.tokenUsage.sessions', 'Sessions')} 
              value={stats.sessions.total.toString()} 
            />
            <SummaryCard 
              label={t('settings.tokenUsage.tasksCompleted', 'Tasks Completed')} 
              value={stats.taskCompleted.toString()} 
            />
            <SummaryCard 
              label={t('settings.tokenUsage.feedbackCount', 'Feedback Count')} 
              value={stats.feedbackCount.toString()} 
            />
            <SummaryCard 
              label={t('settings.tokenUsage.sessionsWithFeedback', 'Sessions w/ Feedback')} 
              value={stats.sessions.withFeedback.toString()} 
            />
          </div>

          {/* Metadata */}
          <div className="space-y-1 rounded-lg border border-border bg-paper px-4 py-3">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{t('settings.tokenUsage.createdAt', 'Created at:')}</span>
              <span className="font-medium">{new Date(stats.createdAt).toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{t('settings.tokenUsage.lastUpdated', 'Last updated:')}</span>
              <span className="font-medium">{new Date(stats.lastUpdated).toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{t('settings.tokenUsage.version', 'Version:')}</span>
              <span className="font-medium">{stats.version}</span>
            </div>
          </div>
        </>
      )}

      {!stats && !isLoading && !error && (
        <div className="text-center py-8 text-sm text-muted-foreground">
          {t('settings.tokenUsage.noData', 'No stats available. Stats will be created automatically when you start working.')}
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={cn(
      "rounded-lg border border-border bg-paper px-4 py-3",
      highlight && "bg-selected/60"
    )}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn(
        "mt-1 text-lg font-semibold text-foreground",
      )}>
        {value}
      </div>
    </div>
  )
}
