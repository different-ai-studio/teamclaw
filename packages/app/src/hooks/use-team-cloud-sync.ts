import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useTeamModeStore } from '@/stores/team-mode'
import { useTeamShareStore, isShareModeLocked } from '@/stores/team-share'
import { useOssSyncStore } from '@/stores/oss-sync'
import { TEAM_SYNCED_EVENT } from '@/lib/build-config'
import { linkDaemonTeamWorkspace } from '@/lib/daemon-local-client'
import { isTauri } from '@/lib/utils'

/**
 * Manual "sync with the cloud" action for toolbar buttons.
 *
 * Dispatches on the team's locked share mode — OSS → `oss_sync_now`, git →
 * `team_shared_git_sync` — the same split TeamSharedFilesBrowser implements
 * for the file tree. `available` is false while the team has no locked share
 * mode, so callers can hide the button entirely.
 *
 * On success (either mode) a TEAM_SYNCED_EVENT is dispatched; consumers that
 * need to reload after a sync should listen for that event rather than wrap
 * `syncNow`, so they also pick up syncs triggered from other surfaces.
 */
export function useTeamCloudSync() {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const shareMode = useTeamShareStore((s) => s.status.mode)
  const refreshShare = useTeamShareStore((s) => s.refresh)
  const ossSyncing = useOssSyncStore((s) => s.syncing)
  const ossSyncNow = useOssSyncStore((s) => s.syncNow)
  const [gitSyncing, setGitSyncing] = React.useState(false)

  const isOssShare = shareMode === 'oss'
  const isGitShare = shareMode === 'managed_git' || shareMode === 'custom_git'
  const available = isTauri() && !!workspacePath && (isOssShare || isGitShare)
  const syncing = gitSyncing || ossSyncing

  const syncOss = React.useCallback(async () => {
    if (!workspacePath) return
    await ossSyncNow(workspacePath)
    const err = useOssSyncStore.getState().lastError
    if (err) {
      toast.error(t('teamShare.cloudSyncFailed', 'Sync failed: {{msg}}', { msg: err }))
      return
    }
    window.dispatchEvent(new CustomEvent(TEAM_SYNCED_EVENT))
  }, [workspacePath, ossSyncNow, t])

  const syncGit = React.useCallback(async () => {
    if (!workspacePath) return
    setGitSyncing(true)
    useTeamModeStore.setState({ teamGitSyncing: true })
    try {
      if (teamId) {
        // Re-check against the server: the locally cached mode may be stale,
        // and Sync Now must never be the thing that enables team share.
        const latest = await refreshShare(teamId, workspacePath)
        if (!isShareModeLocked(latest.mode) || latest.mode === 'oss') {
          toast.error(
            t(
              'settings.team.cloudShareRequiredBeforeSync',
              'Team share is not locked on the cloud yet. Use Enable (Self-hosted Git) first — Sync Now cannot enable it.',
            ),
          )
          return
        }
      }
      await linkDaemonTeamWorkspace(workspacePath)
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke<{ success: boolean; message: string }>(
        'team_shared_git_sync',
        { config: { workspacePath }, force: false, forceSync: true },
      )
      if (result.success) {
        toast.success(result.message)
        useTeamModeStore.setState({ teamGitLastSyncAt: new Date().toISOString() })
        window.dispatchEvent(new CustomEvent(TEAM_SYNCED_EVENT))
      } else {
        toast.error(result.message)
      }
    } catch (err) {
      toast.error(String(err))
    } finally {
      setGitSyncing(false)
      useTeamModeStore.setState({ teamGitSyncing: false })
    }
  }, [workspacePath, teamId, refreshShare, t])

  const syncNow = React.useCallback(async () => {
    if (!available || syncing) return
    if (isOssShare) await syncOss()
    else await syncGit()
  }, [available, syncing, isOssShare, syncOss, syncGit])

  return { available, syncing, syncNow }
}
