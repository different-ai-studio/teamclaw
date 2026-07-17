import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, FolderGit2, Link2 } from 'lucide-react'

import { cn, isTauri, copyToClipboard } from '@/lib/utils'
import { getFreshAccessToken } from '@/lib/auth/session-store'
import { getEffectiveServerConfigSync } from '@/lib/server-config'

/**
 * TeamSyncPaths — shows *where team content physically lives* and *every
 * `teamclaw-team` symlink that points at it*, for all three share modes
 * (OSS / 自建 Git / 托管 Git).
 *
 * All modes converge on one real directory per team
 * (`~/.amuxd/teams/<team_id>/teamclaw-team`, the daemon's global copy — git
 * modes clone into it) with a `teamclaw-team` symlink in each joined workspace.
 * The data comes from the `team_sync_paths` Tauri command, which reads the
 * current workspace locally and fetches the rest of the team's workspaces
 * from the Cloud API, so this renders the same in every panel.
 */

type LinkStatus = 'symlink' | 'real_dir' | 'missing'

interface WorkspaceLink {
  workspacePath: string
  displayName: string
  linkPath: string
  status: LinkStatus
  isCurrent: boolean
}

interface TeamSyncPathsData {
  realDir: string | null
  realDirExists: boolean
  links: WorkspaceLink[]
}

const STATUS_META: Record<
  LinkStatus,
  { labelKey: string; className: string }
> = {
  symlink: {
    labelKey: 'settings.teamShare.linkStatus.linked',
    className:
      'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  real_dir: {
    labelKey: 'settings.teamShare.linkStatus.pendingMigration',
    className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  missing: {
    labelKey: 'settings.teamShare.linkStatus.unlinked',
    className: 'bg-muted text-muted-foreground',
  },
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      type="button"
      aria-label={t('settings.teamShare.copyPath')}
      title={t('settings.teamShare.copyPath')}
      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      onClick={() => {
        void copyToClipboard(value)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  )
}

export function TeamSyncPaths({
  teamId,
  workspacePath,
  refreshKey = 0,
  className,
}: {
  teamId: string | null
  workspacePath: string | null
  /** Bump after sync/disconnect to re-fetch path status. */
  refreshKey?: number
  className?: string
}) {
  const { t } = useTranslation()
  const [data, setData] = React.useState<TeamSyncPathsData | null>(null)

  React.useEffect(() => {
    if (!workspacePath || !isTauri()) return
    let cancelled = false
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        // Global sync dir is materialized under the daemon's onboarded team, not
        // necessarily the app UI's current team when the two have diverged.
        const daemonTeamId = await invoke<string | null>('get_daemon_team_id')
        const pathTeamId = daemonTeamId ?? teamId
        if (!pathTeamId) return
        // Best-effort: other-workspace links come from the Cloud API now, so
        // this needs an access token. If the token fetch fails we still show
        // the current workspace (the command tolerates a missing token).
        const accessToken = await getFreshAccessToken().catch(() => null)
        const cloudApiUrl = getEffectiveServerConfigSync().cloudApiUrl ?? null
        const res = await invoke<TeamSyncPathsData>('team_sync_paths', {
          teamId: pathTeamId,
          workspacePath,
          accessToken,
          cloudApiUrl,
        })
        if (!cancelled) setData(res)
      } catch {
        // Best-effort: if the command fails we simply omit the paths block
        // rather than breaking the surrounding panel.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [teamId, workspacePath, refreshKey])

  if (!data || (!data.realDir && data.links.length === 0)) return null

  return (
    <div
      className={cn(
        'rounded-lg border border-border/50 bg-card/50 p-4',
        className,
      )}
    >
      <h4 className="mb-3 text-[13px] font-medium text-foreground/80">
        {t('settings.teamShare.syncPaths')}
      </h4>

      {/* Real sync directory */}
      {data.realDir && (
        <div className="mb-3">
          <div className="mb-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <FolderGit2 className="h-3.5 w-3.5" />
            {t('settings.teamShare.realSyncDir')}
            <span
              className={cn(
                'ml-1 rounded px-1.5 py-0.5 text-[10px]',
                data.realDirExists
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {data.realDirExists
                ? t('settings.teamShare.dirExists')
                : t('settings.teamShare.dirNotCreated')}
            </span>
          </div>
          <div className="flex items-start gap-2 rounded-md border border-border/40 bg-background/50 px-2.5 py-1.5">
            <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-foreground/90">
              {data.realDir}
            </code>
            <CopyButton value={data.realDir} />
          </div>
        </div>
      )}

      {/* Workspace symlinks */}
      {data.links.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Link2 className="h-3.5 w-3.5" />
            {t('settings.teamShare.workspaceSymlinks', {
              count: data.links.length,
            })}
          </div>
          <ul className="divide-y divide-border/40 rounded-md border border-border/40">
            {data.links.map((link) => {
              const meta = STATUS_META[link.status]
              return (
                <li
                  key={link.linkPath}
                  className="flex items-start justify-between gap-2 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[12px] font-medium text-foreground/90">
                        {link.displayName}
                      </span>
                      {link.isCurrent && (
                        <span className="shrink-0 rounded bg-coral/15 px-1.5 py-0.5 text-[10px] text-coral">
                          {t('settings.teamShare.current')}
                        </span>
                      )}
                    </div>
                    <code
                      className="block break-all font-mono text-[11px] text-muted-foreground"
                      title={link.linkPath}
                    >
                      {link.linkPath}
                    </code>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px]',
                        meta.className,
                      )}
                    >
                      {t(meta.labelKey)}
                    </span>
                    <CopyButton value={link.linkPath} />
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
