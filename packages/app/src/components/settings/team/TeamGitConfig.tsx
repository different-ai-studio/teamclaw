import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import {
  Users,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  Clock,
  KeyRound,
  ChevronRight,
  BookOpen,
  Loader2,
  RotateCcw,
} from 'lucide-react'
import { cn, isTauri } from '@/lib/utils'
import { DaemonOnboardingWizard } from '@/components/auth/DaemonOnboardingWizard'
import { TeamSyncPaths } from './TeamSyncPaths'
import { TeamShareDisconnect } from './TeamShareDisconnect'
import { TeamShareSection } from './TeamShareSection'
import { TeamSecretEntry } from './TeamSecretEntry'
import { useTeamPermissions } from '@/lib/team-permissions'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useTeamShareStore, isShareModeLocked } from '@/stores/team-share'
import { linkDaemonTeamWorkspace } from '@/lib/daemon-local-client'
import { buildConfig, TEAM_SYNCED_EVENT, TEAM_REPO_DIR } from '@/lib/build-config'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

// The daemon proxy returns `needsConfirmation` when the local team dir exists
// but is not a git repository (user must confirm delete + re-clone).
interface TeamGitResult {
  success: boolean
  message: string
  needsConfirmation?: boolean
  confirmKind?: 'wipeNonGitDir'
}

interface DaemonSyncStatus {
  mode: string | null
  lastSyncAt: string | null
  syncing: boolean
  lastError: string | null
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`Team feature requires ${buildConfig.app.name} desktop app (Tauri not available)`)
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

/**
 * The daemon refused sync because it can't read this team's share-mode on the
 * cloud (FC returns unset/404 for the daemon's own identity), so it replies
 * with the dedicated `team_share_not_enabled_for_daemon` 422. The desktop
 * proxy forwards the daemon's problem+json body verbatim inside the error
 * string, so we branch on the stable machine-readable `code` rather than the
 * human-readable detail. This happens when team_id matches but the daemon's
 * binding/credentials are stale — the fix is to rebind the daemon.
 */
function isDaemonShareUnsetError(message: string | null | undefined): boolean {
  return !!message && message.includes('team_share_not_enabled_for_daemon')
}

function isNonGitDirError(message: string | null | undefined): boolean {
  return !!message && message.includes('team_shared_dir_not_git')
}

// ─── Reusable Components (local to git config) ─────────────────────────────

function SettingCard({
  children,
  className,
  ...rest
}: React.ComponentProps<'div'>) {
  return (
    <div className={cn('rounded-xl border bg-card p-5 transition-all', className)} {...rest}>
      {children}
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TeamGitConfig() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const status = useTeamShareStore((s) => s.status)
  const shareLoading = useTeamShareStore((s) => s.loading)
  const refreshShare = useTeamShareStore((s) => s.refresh)
  const { isOwner } = useTeamPermissions()
  const { t } = useTranslation()

  const isCloudGitEnabled = isShareModeLocked(status.mode)

  if (!teamId || !workspacePath) return null

  if (!isCloudGitEnabled) {
    if (shareLoading) {
      return (
        <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('settings.team.loadingShareMode', 'Loading team share status…')}
        </div>
      )
    }
    return (
      <div className="space-y-4">
        <SettingCard className="border-amber-500/30 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 space-y-1">
              <p className="text-[13px] font-medium text-amber-800 dark:text-amber-300">
                {t('settings.team.cloudShareRequiredTitle', 'Team share is not enabled on the cloud yet')}
              </p>
              <p className="text-[12px] leading-5 text-amber-800/80 dark:text-amber-300/80">
                {t(
                  'settings.team.cloudShareRequiredDesc',
                  'Sync requires locking a share mode on the server first. Use Enable below (Self-hosted Git), then Sync Now.',
                )}
              </p>
            </div>
          </div>
        </SettingCard>
        <TeamShareSection
          teamId={teamId}
          workspacePath={workspacePath}
          isOwner={isOwner}
          skipInitialRefresh
          onConfigured={() => void refreshShare(teamId, workspacePath)}
        />
      </div>
    )
  }

  return <TeamGitConfigConnected teamId={teamId} workspacePath={workspacePath} />
}

function TeamGitConfigConnected({
  teamId,
  workspacePath,
}: {
  teamId: string
  workspacePath: string
}) {
  const { t } = useTranslation()
  const status = useTeamShareStore((s) => s.status)
  const refresh = useTeamShareStore((s) => s.refresh)

  const [syncing, setSyncing] = React.useState(false)
  const [pathsRefreshKey, setPathsRefreshKey] = React.useState(0)
  const [syncStatus, setSyncStatus] = React.useState<DaemonSyncStatus | null>(null)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const [repoGuideOpen, setRepoGuideOpen] = React.useState(false)
  const [daemonTeamId, setDaemonTeamId] = React.useState<string | null>(null)
  const [rebinding, setRebinding] = React.useState(false)
  const [wipeConfirmOpen, setWipeConfirmOpen] = React.useState(false)
  const onboardingStatus = useDaemonOnboardingStore((s) => s.status)
  const onboardingBusy = useDaemonOnboardingStore((s) => s.busy)
  const forceResetDaemon = useDaemonOnboardingStore((s) => s.forceReset)

  const sharedDirName = TEAM_REPO_DIR

  const refreshDaemonTeamId = React.useCallback(async () => {
    if (!isTauri()) return
    try {
      const id = await invoke<string | null>('get_daemon_team_id')
      setDaemonTeamId(id ?? null)
    } catch {
      setDaemonTeamId(null)
    }
  }, [])

  const refreshSyncStatus = React.useCallback(async () => {
    if (!workspacePath || !teamId || !isTauri()) return
    try {
      const daemonStatus = await invoke<DaemonSyncStatus>('oss_sync_status', {
        workspacePath,
        teamId,
      })
      setSyncStatus({
        mode: daemonStatus.mode ?? null,
        lastSyncAt: daemonStatus.lastSyncAt ?? null,
        syncing: daemonStatus.syncing ?? false,
        lastError: daemonStatus.lastError ?? null,
      })
    } catch (err) {
      console.warn('[TeamGitConfig] failed to load daemon sync status:', err)
    }
  }, [teamId, workspacePath])

  const isCloudGitEnabled = isShareModeLocked(status.mode)
  const isWorkspaceLinked =
    status.linkStatus === 'symlink' || status.linkStatus === 'real_dir'

  const linkRepairKeyRef = React.useRef<string | null>(null)

  // Keep the FC share-mode status fresh (TeamSection resolves it before mounting
  // us; this re-fetch covers team/workspace switches while the pane is open).
  React.useEffect(() => {
    if (!teamId || !workspacePath || !isTauri()) return
    void refresh(teamId, workspacePath)
    void refreshDaemonTeamId()
    void refreshSyncStatus()
  }, [teamId, workspacePath, refresh, refreshDaemonTeamId, refreshSyncStatus])

  // Repair workspace symlink once per team+workspace when cloud git is enabled.
  React.useEffect(() => {
    if (!isCloudGitEnabled || isWorkspaceLinked) return
    const key = `${teamId}:${workspacePath}`
    if (linkRepairKeyRef.current === key) return
    linkRepairKeyRef.current = key
    void (async () => {
      await linkDaemonTeamWorkspace(workspacePath)
      setPathsRefreshKey((k) => k + 1)
    })()
  }, [teamId, workspacePath, isCloudGitEnabled, isWorkspaceLinked])

  // Poll while the daemon reports an in-flight sync (e.g. background timer clone).
  React.useEffect(() => {
    if (!syncStatus?.syncing || !workspacePath || !teamId || !isTauri()) return
    const id = window.setInterval(() => {
      void refreshSyncStatus()
    }, 3000)
    return () => window.clearInterval(id)
  }, [syncStatus?.syncing, workspacePath, teamId, refreshSyncStatus])

  const modeLabel =
    status.mode === 'managed_git'
      ? t('settings.teamShare.modeManagedGitLabel', 'Managed Git')
      : status.mode === 'custom_git'
        ? t('settings.teamShare.modeCustomGitLabel', 'Self-hosted Git')
        : t('settings.team.teamRepo', 'Team Shared Directory')

  const daemonSyncing = syncing || (syncStatus?.syncing ?? false)
  const teamMismatch = !!daemonTeamId && !!teamId && daemonTeamId !== teamId
  const rawSyncError = errorMessage ?? syncStatus?.lastError ?? null
  // team_id matches but the daemon's identity can't read this team's share-mode
  // on the cloud — same remedy as a mismatch (rebind), so funnel it into the
  // same amber card + action and hide the raw 422 from the user.
  const daemonShareUnset = isCloudGitEnabled && isDaemonShareUnsetError(rawSyncError)
  const needsRebind = teamMismatch || daemonShareUnset
  const nonGitDirBlocked = isNonGitDirError(rawSyncError)
  const combinedError = needsRebind || nonGitDirBlocked ? null : rawSyncError

  // Open the re-onboard flow. For a true team mismatch the wizard already lands
  // on its 'mismatch' screen (reset + re-init). But in the share-unset case the
  // daemon team *equals* the current team, so onboarding status computes as
  // 'ready' and the wizard would immediately self-close (onDone) without doing
  // anything. Force a reset first (clears the stale binding → status flips to
  // 'needs-onboard'), then open the wizard so the user can re-onboard and the
  // daemon's agent actually (re)joins the current team. Awaiting the reset
  // before opening avoids the 'ready' self-close race.
  const handleRebind = async () => {
    if (daemonShareUnset && !teamMismatch) {
      await forceResetDaemon()
    }
    setRebinding(true)
  }

  // Close the rebind overlay (whether the user finished or cancelled) and clear
  // the stale 422 that drove the rebind card. Otherwise that error lingers in
  // state, keeps the card up + Sync Now disabled, and the user can't click Sync
  // Now to clear it — a dead end. refreshSyncStatus repopulates real state.
  const closeRebindAndRefresh = () => {
    setRebinding(false)
    setErrorMessage(null)
    setSyncStatus((prev) => (prev ? { ...prev, lastError: null } : prev))
    void refreshDaemonTeamId()
    if (teamId && workspacePath) {
      void refresh(teamId, workspacePath)
      void refreshSyncStatus()
    }
    setPathsRefreshKey((k) => k + 1)
  }

  // ─── Sync flow — daemon-owned; the proxy only needs workspacePath ─────────

  const performSync = async (forceWipeNonGit = false) => {
    if (!workspacePath) {
      setErrorMessage(t('settings.team.noWorkspace', 'No workspace selected'))
      return
    }
    setSyncing(true)
    if (!forceWipeNonGit) {
      setErrorMessage(null)
    }
    try {
      if (teamId) {
        const latest = await refresh(teamId, workspacePath)
        if (!isShareModeLocked(latest.mode) || latest.mode === 'oss') {
          setErrorMessage(
            t(
              'settings.team.cloudShareRequiredBeforeSync',
              'Team share is not locked on the cloud yet. Use Enable (Self-hosted Git) first — Sync Now cannot enable it.',
            ),
          )
          return
        }
      }
      const { invoke } = await import('@tauri-apps/api/core')
      const boundTeamId = await invoke<string | null>('get_daemon_team_id')
      setDaemonTeamId(boundTeamId ?? null)
      if (boundTeamId && teamId && boundTeamId !== teamId) {
        return
      }
      // Materialize workspace symlink → global copy before sync.
      await linkDaemonTeamWorkspace(workspacePath, { strict: true })
      const result = await tauriInvoke<TeamGitResult>('team_shared_git_sync', {
        config: { workspacePath },
        force: forceWipeNonGit,
      })
      if (result.needsConfirmation && result.confirmKind === 'wipeNonGitDir') {
        setWipeConfirmOpen(true)
        return
      }
      if (!result.success) {
        setErrorMessage(result.message)
        return
      }
      setWipeConfirmOpen(false)
      setErrorMessage(null)
      setSyncStatus((prev) => (prev ? { ...prev, lastError: null } : prev))
      window.dispatchEvent(new CustomEvent(TEAM_SYNCED_EVENT))
      setPathsRefreshKey((k) => k + 1)
      if (teamId) void refresh(teamId, workspacePath)
      await refreshSyncStatus()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isNonGitDirError(message)) {
        setWipeConfirmOpen(true)
        return
      }
      setErrorMessage(message)
    } finally {
      setSyncing(false)
    }
  }

  // ─── Format last sync time ───────────────────────────────────────────────

  const formatLastSync = (isoString: string | null) => {
    if (!isoString) return t('settings.team.never', 'Never')
    try {
      const date = new Date(isoString)
      const now = new Date()
      const diffMins = Math.floor((now.getTime() - date.getTime()) / 60000)
      if (diffMins < 1) return t('settings.team.justNow', 'Just now')
      if (diffMins < 60) return t('settings.team.minutesAgo', { count: diffMins, defaultValue: `${diffMins}m ago` })
      const diffHours = Math.floor(diffMins / 60)
      if (diffHours < 24) return t('settings.team.hoursAgo', { count: diffHours, defaultValue: `${diffHours}h ago` })
      const diffDays = Math.floor(diffHours / 24)
      return t('settings.team.daysAgo', { count: diffDays, defaultValue: `${diffDays}d ago` })
    } catch {
      return isoString
    }
  }

  // Legacy routing (or stale local state) can land here while Cloud share_mode is
  // still unset. Sync Now only talks to the daemon, which reads FC — show the
  // enable flow instead of a misleading Connected + Sync surface.
  // (Handled by TeamGitConfig wrapper before this component mounts.)

  return (
    <>
      {needsRebind && (
        <SettingCard className="border-amber-500/30 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 space-y-1.5">
              <p className="text-[13px] font-medium text-amber-700 dark:text-amber-400">
                {teamMismatch
                  ? t('settings.daemonGeneral.teamMismatchTitle', '本机 Daemon 与当前团队不一致')
                  : t('settings.team.daemonShareUnsetTitle', '本机 Daemon 无法读取团队共享配置')}
              </p>
              <p className="text-[12px] leading-5 text-amber-700/80 dark:text-amber-400/80">
                {teamMismatch
                  ? t('settings.team.daemonTeamMismatch', {
                      daemonTeamId,
                      currentTeamId: teamId,
                      defaultValue:
                        `Local daemon is bound to team ${daemonTeamId}, but you are signed in as ${teamId}. Click "Rebind to current team" below, then sync again.`,
                    })
                  : t(
                      'settings.team.daemonShareUnsetDesc',
                      'Team share is enabled on the cloud, but the local daemon’s credentials can’t read this team’s share config. Click "Rebind to current team" below, then sync again.',
                    )}
              </p>
              {teamMismatch && (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-0.5 pt-0.5 text-[11px]">
                  <dt className="text-amber-700/70 dark:text-amber-400/70">
                    {t('settings.daemonGeneral.daemonTeam', 'Daemon 团队')}
                  </dt>
                  <dd className="truncate font-mono text-amber-800 dark:text-amber-300">{daemonTeamId}</dd>
                  <dt className="text-amber-700/70 dark:text-amber-400/70">
                    {t('settings.daemonGeneral.currentTeam', '当前团队')}
                  </dt>
                  <dd className="truncate font-mono text-amber-800 dark:text-amber-300">{teamId}</dd>
                </dl>
              )}
              <div className="pt-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 border-amber-500/40 bg-transparent text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
                  onClick={() => void handleRebind()}
                  disabled={rebinding || onboardingBusy}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('settings.daemonGeneral.rebind', '重新绑定到当前团队')}
                </Button>
              </div>
            </div>
          </div>
        </SettingCard>
      )}

      {isCloudGitEnabled && !isWorkspaceLinked && !needsRebind && (
        <SettingCard className="border-amber-500/30 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 space-y-1">
              <p className="text-[13px] font-medium text-amber-800 dark:text-amber-300">
                {t('settings.team.localLinkPendingTitle', 'Cloud share is enabled; local directory not linked yet')}
              </p>
              <p className="text-[12px] leading-5 text-amber-800/80 dark:text-amber-300/80">
                {t(
                  'settings.team.localLinkPendingDesc',
                  'Team share is locked on the server. Click Sync Now to clone the repo and create the workspace symlink.',
                )}
              </p>
            </div>
          </div>
        </SettingCard>
      )}

      {nonGitDirBlocked && !needsRebind && (
        <SettingCard className="border-amber-500/30 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 space-y-1.5">
              <p className="text-[13px] font-medium text-amber-800 dark:text-amber-300">
                {t('settings.team.nonGitDirTitle', 'Local team directory is not a git repository')}
              </p>
              <p className="text-[12px] leading-5 text-amber-800/80 dark:text-amber-300/80">
                {t(
                  'settings.team.nonGitDirDesc',
                  'The real sync directory exists but was never cloned (or lost its .git folder). Delete it and clone from the remote to continue syncing.',
                )}
              </p>
              <div className="pt-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 border-amber-500/40 bg-transparent text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
                  onClick={() => setWipeConfirmOpen(true)}
                  disabled={daemonSyncing}
                >
                  {t('settings.team.nonGitDirAction', 'Delete and re-clone')}
                </Button>
              </div>
            </div>
          </div>
        </SettingCard>
      )}

      {/* Error Banner */}
      {combinedError && (
        <SettingCard className="bg-gradient-to-br from-red-50 to-rose-50 dark:from-red-950/30 dark:to-rose-950/30 border-red-200 dark:border-red-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-red-900 dark:text-red-100">{t('common.error', 'Error')}</p>
              <p className="text-[13px] text-red-700 dark:text-red-300 mt-1 break-words">
                {combinedError}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => {
                setErrorMessage(null)
                setSyncStatus((prev) => (prev ? { ...prev, lastError: null } : prev))
              }}
            >
              ✕
            </Button>
          </div>
        </SettingCard>
      )}

      {/* Status Card */}
      <SettingCard className="border-violet-200 dark:border-violet-800 bg-gradient-to-br from-violet-50/50 to-purple-50/50 dark:from-violet-950/20 dark:to-purple-950/20">
        <div className="space-y-4">
          {/* Header with status */}
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-9 w-9 shrink-0 rounded-lg flex items-center justify-center bg-violet-100 dark:bg-violet-900/30">
              <Users className="h-5 w-5 text-violet-700 dark:text-violet-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-[13px] font-medium">{modeLabel}</p>
                {isWorkspaceLinked ? (
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-3 w-3" />
                    {t('settings.llm.connected', 'Connected')}
                  </span>
                ) : (
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" />
                    {t('settings.team.pendingLocalLink', 'Pending local link')}
                  </span>
                )}
              </div>
              {status.gitRemoteUrl && (
                <div className="flex items-center gap-2 mt-0.5 min-w-0">
                  <p
                    className="text-xs text-muted-foreground font-mono truncate min-w-0"
                    title={status.gitRemoteUrl}
                  >
                    {status.gitRemoteUrl}
                  </p>
                  {status.gitAuthKind && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                      <KeyRound className="h-2.5 w-2.5" />
                      {status.gitAuthKind === 'ssh_key'
                        ? t('settings.team.authSsh', 'SSH')
                        : t('settings.team.token', 'Token')}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Last sync info + actions */}
          <TeamShareDisconnect
            variant="footer"
            onDisconnected={() => {
              setSyncStatus(null)
              setPathsRefreshKey((k) => k + 1)
            }}
            leading={
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                {daemonSyncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Clock className="h-3.5 w-3.5" />
                )}
                {t('settings.team.lastSynced', 'Last synced')}:{' '}
                {formatLastSync(syncStatus?.lastSyncAt ?? null)}
              </div>
            }
            trailingActions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void performSync()}
                disabled={daemonSyncing || !workspacePath || needsRebind}
                className="shrink-0 gap-2"
              >
                <RefreshCw className={cn('h-3 w-3 shrink-0', daemonSyncing && 'animate-spin')} />
                {t('settings.team.syncNow', 'Sync Now')}
              </Button>
            }
          />
        </div>
      </SettingCard>

      {/* Real sync directory + every workspace symlink (all 3 share modes) */}
      <TeamSyncPaths
        teamId={teamId}
        workspacePath={workspacePath}
        refreshKey={pathsRefreshKey}
      />

      {/* Team secret re-entry */}
      <SettingCard className="bg-muted/30">
        <p className="text-[12px] font-medium text-foreground/70 mb-1">
          {t('settings.teamSecret.updateSectionTitle')}
        </p>
        <p className="text-[11.5px] text-muted-foreground mb-3">
          {t('settings.teamSecret.updateSectionDesc')}
        </p>
        <TeamSecretEntry teamId={teamId} workspacePath={workspacePath} allowGenerate />
      </SettingCard>

      {/* Repo setup guide */}
      <Collapsible open={repoGuideOpen} onOpenChange={setRepoGuideOpen}>
        <SettingCard className="bg-muted/30 border-dashed">
          <CollapsibleTrigger className="flex w-full items-center gap-3 text-left hover:opacity-80 transition-opacity">
            <BookOpen className="h-5 w-5 text-violet-500 shrink-0" />
            <span className="font-medium text-[13px]">
              {t('settings.team.repoGuide.title', 'How to set up a team repository')}
            </span>
            <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', repoGuideOpen && 'rotate-90')} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-4 pt-4 border-t space-y-4 text-[13px] text-muted-foreground">
              <p>
                {t('settings.team.repoGuide.intro', { defaultValue: 'A shared repository for your team to centrally manage Agent Skills, MCP configurations, and knowledge documents. Use the structure below so {{appName}} can sync correctly.', appName: buildConfig.app.name })}
              </p>
              <div>
                <h5 className="font-medium text-foreground mb-1.5">
                  {t('settings.team.repoGuide.structureTitle', 'Repository structure')}
                </h5>
                <pre className="bg-muted rounded-md p-3 font-mono text-xs overflow-x-auto whitespace-pre">
                  {t('settings.team.repoGuide.structureTree', '.\n├── skills/\n├── .mcp/\n├── knowledge/\n├── .gitignore\n└── README.md')}
                </pre>
              </div>
              <div>
                <h5 className="font-medium text-foreground mb-1.5">
                  {t('settings.team.repoGuide.dirDetailsTitle', 'Directory details')}
                </h5>
                <ul className="space-y-2">
                  <li>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{t('settings.team.repoGuide.dirSkillsTitle', 'skills/')}</code>
                    <span className="ml-1">{t('settings.team.repoGuide.dirSkills', 'Shared Agent Skill definitions (SKILL.md).')}</span>
                  </li>
                  <li>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{t('settings.team.repoGuide.dirMcpTitle', '.mcp/')}</code>
                    <span className="ml-1">{t('settings.team.repoGuide.dirMcp', 'Shared MCP Server config files.')}</span>
                  </li>
                  <li>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{t('settings.team.repoGuide.dirKnowledgeTitle', 'knowledge/')}</code>
                    <span className="ml-1">{t('settings.team.repoGuide.dirKnowledge', 'Shared knowledge documents.')}</span>
                  </li>
                </ul>
              </div>
              <div>
                <h5 className="font-medium text-foreground mb-1.5">
                  {t('settings.team.repoGuide.usageTitle', 'Usage')}
                </h5>
                <ol className="list-decimal list-inside space-y-1">
                  <li>{t('settings.team.repoGuide.usage1', { defaultValue: 'Clone the repo; {{appName}} will create a {{teamRepoDir}} folder in your workspace.', appName: buildConfig.app.name, teamRepoDir: sharedDirName })}</li>
                  <li>{t('settings.team.repoGuide.usage2', 'Whitelist .gitignore: only the three directories are tracked.')}</li>
                  <li>{t('settings.team.repoGuide.usage3', 'In Cursor, use @ to reference Skills and Knowledge.')}</li>
                </ol>
              </div>
              <div>
                <h5 className="font-medium text-foreground mb-1.5">
                  {t('settings.team.repoGuide.contributingTitle', 'Contributing')}
                </h5>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>{t('settings.team.repoGuide.contributingSkills', 'Add Skill: subdirectory under skills/ with SKILL.md.')}</li>
                  <li>{t('settings.team.repoGuide.contributingMcp', 'Add MCP: <server-name>.json under .mcp/.')}</li>
                  <li>{t('settings.team.repoGuide.contributingKnowledge', 'Add knowledge: files in knowledge/, Markdown recommended.')}</li>
                  <li>{t('settings.team.repoGuide.contributingSecurity', 'No sensitive data (keys, credentials) in commits.')}</li>
                </ul>
              </div>
            </div>
          </CollapsibleContent>
        </SettingCard>
      </Collapsible>

      {rebinding && (
        <div className="fixed inset-0 z-50">
          {(onboardingStatus === 'mismatch' || onboardingStatus === 'needs-onboard') &&
            !onboardingBusy && (
              <button
                type="button"
                onClick={closeRebindAndRefresh}
                className="absolute right-5 top-5 z-10 rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
              >
                {t('common.cancel', '取消')}
              </button>
            )}
          <DaemonOnboardingWizard onDone={closeRebindAndRefresh} />
        </div>
      )}

      <AlertDialog open={wipeConfirmOpen} onOpenChange={setWipeConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.team.nonGitDirConfirmTitle', 'Delete local team directory?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'settings.team.nonGitDirConfirmDesc',
                'This will permanently delete the local team shared directory and clone it again from the remote. Unsynced local files in that directory will be lost.',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={daemonSyncing}>
              {t('common.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={daemonSyncing}
              onClick={(event) => {
                event.preventDefault()
                void performSync(true)
              }}
            >
              {t('settings.team.nonGitDirConfirmAction', 'Delete and re-clone')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
