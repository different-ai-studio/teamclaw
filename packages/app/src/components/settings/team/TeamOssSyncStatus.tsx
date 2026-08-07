import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Loader2, AlertCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useOssSyncStore } from '@/stores/oss-sync'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import { isTauri } from '@/lib/utils'
import { TeamSyncPaths } from './TeamSyncPaths'
import { TeamShareDisconnect } from './TeamShareDisconnect'

/**
 * OSS sync status panel — shown when a team's share mode is locked to 'oss'.
 *
 * The desktop now proxies team-sync to the amuxd daemon, which reports only an
 * AGGREGATE status: { mode, lastSyncAt, syncing, lastError, pulled, pushed,
 * conflicts }. Per-file detail (dirtyCount / totalFiles / recentFiles) is no
 * longer available, so this panel surfaces sync state + counters + errors.
 */
function formatTimestamp(raw: string | null, locale: string | undefined): string | null {
  if (!raw) return null
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(locale || undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  )
}

export function TeamOssSyncStatus() {
  const { t, i18n } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const lastSyncAt = useOssSyncStore((s) => s.lastSyncAt)
  const pulled = useOssSyncStore((s) => s.pulled)
  const pushed = useOssSyncStore((s) => s.pushed)
  const conflicts = useOssSyncStore((s) => s.conflicts)
  const syncing = useOssSyncStore((s) => s.syncing)
  const lastError = useOssSyncStore((s) => s.lastError)
  const refresh = useOssSyncStore((s) => s.refresh)
  const syncNow = useOssSyncStore((s) => s.syncNow)

  React.useEffect(() => {
    if (!workspacePath || !isTauri()) return
    void refresh(workspacePath)
  }, [workspacePath, teamId, refresh])

  const lastSyncLabel =
    formatTimestamp(lastSyncAt, i18n?.language) ??
    t('settings.team.oss.never', 'Not synced yet')

  return (
    <div className="rounded-lg border border-border/50 bg-card/50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-[13px] font-medium text-foreground/80">
          {t('settings.team.oss.title', 'OSS sync')}
        </h4>
        <Button
          size="sm"
          variant="outline"
          disabled={syncing || !workspacePath}
          onClick={() => workspacePath && void syncNow(workspacePath)}
          data-testid="oss-sync-now"
        >
          {syncing ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t('settings.team.oss.syncNow', 'Sync now')}
        </Button>
      </div>

      <div className="divide-y divide-border/40">
        <StatRow
          label={t('settings.team.oss.status', 'Status')}
          value={
            <span className="inline-flex items-center gap-1.5">
              {syncing ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
                  {t('settings.team.oss.syncingLabel', 'Syncing…')}
                </>
              ) : (
                <>
                  <span
                    className={`h-2 w-2 rounded-full ${lastError ? 'bg-destructive' : 'bg-emerald-500'}`}
                  />
                  {lastError
                    ? t('settings.team.oss.error', 'Error')
                    : t('settings.team.oss.idle', 'Idle')}
                </>
              )}
            </span>
          }
        />
        <StatRow label={t('settings.team.oss.lastSync', 'Last sync')} value={lastSyncLabel} />
        <StatRow label={t('settings.team.oss.pulled', 'Pulled')} value={pulled} />
        <StatRow label={t('settings.team.oss.pushed', 'Pushed')} value={pushed} />
        <StatRow
          label={t('settings.team.oss.conflicts', 'Conflicts')}
          value={conflicts}
        />
      </div>

      <TeamSyncPaths teamId={teamId} workspacePath={workspacePath} className="mt-4" />

      {lastError && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-words">{lastError}</span>
        </div>
      )}

      <TeamShareDisconnect className="mt-4" />
    </div>
  )
}
