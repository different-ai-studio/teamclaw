import React from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, AlertCircle, Info } from 'lucide-react'
import { exists, readDir } from '@tauri-apps/plugin-fs'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamModeStore } from '@/stores/team-mode'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useTeamShareStore, isShareModeLocked } from '@/stores/team-share'
import { useOssSyncStore } from '@/stores/oss-sync'
import { TEAM_SYNCED_EVENT } from '@/lib/build-config'
import { globalTeamShareDir, TEAM_SHARE_LINK_DIR } from '@/lib/team-skill-paths'
import { linkDaemonTeamWorkspace } from '@/lib/daemon-local-client'
import { cn, isTauri } from '@/lib/utils'

/** Resolution state of the global team share dir on disk. */
type DirState = 'loading' | 'missing' | 'empty' | 'populated'

interface TeamSharedFilesBrowserProps {
  hidePanelToolbar?: boolean
  filterText?: string
  onFilterTextChange?: (value: string) => void
  gitChangedOnly?: boolean
  onGitChangedOnlyChange?: (value: boolean) => void
  searchExpanded?: boolean
  onSearchExpandedChange?: (value: boolean) => void
}

export function TeamSharedFilesBrowser({
  hidePanelToolbar = false,
  filterText,
  onFilterTextChange,
  gitChangedOnly,
  onGitChangedOnlyChange,
  searchExpanded,
  onSearchExpandedChange,
}: TeamSharedFilesBrowserProps = {}) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const refreshFileTree = useWorkspaceStore(s => s.refreshFileTree)
  const teamId = useCurrentTeamStore(s => s.team?.id ?? null)
  const shareMode = useTeamShareStore(s => s.status.mode)
  const globalPath = useTeamShareStore(s => s.status.globalPath ?? null)
  const refreshShare = useTeamShareStore(s => s.refresh)
  const ossSyncing = useOssSyncStore(s => s.syncing)
  const refreshOssSync = useOssSyncStore(s => s.refresh)
  const ossSyncNow = useOssSyncStore(s => s.syncNow)
  const [teamRootPath, setTeamRootPath] = React.useState<string | null>(null)
  const [dirState, setDirState] = React.useState<DirState>('loading')
  const [syncing, setSyncing] = React.useState(false)

  React.useEffect(() => {
    if (!workspacePath) return
    void refreshOssSync(workspacePath)
  }, [workspacePath, refreshOssSync])

  React.useEffect(() => {
    if (!teamId || !workspacePath) return
    void refreshShare(teamId, workspacePath)
  }, [teamId, workspacePath, refreshShare])

  // Resolve the single global team share dir and classify its on-disk state.
  // We deliberately read `~/.amuxd/teams/<team_id>/teamclaw-team` directly (the
  // daemon-owned canonical copy) and never fall back to the per-workspace link.
  const resolveDirState = React.useCallback(async () => {
    if (!isTauri()) {
      setTeamRootPath(null)
      setDirState('missing')
      return
    }
    // Prefer the daemon-reported global path; fall back to deriving it locally.
    const dir = globalPath ?? (await globalTeamShareDir())
    setTeamRootPath(dir)
    if (!dir || !(await exists(dir))) {
      setDirState('missing')
      return
    }
    const entries = await readDir(dir)
    if (entries.length === 0) {
      setDirState('empty')
      return
    }
    {
      // The daemon-owned global dir is outside the workspace boundary, so the
      // workspace-scoped file commands (read_workspace_directory, open, etc.)
      // cannot read it directly. We render through the in-workspace
      // `teamclaw-team` symlink instead; make sure it exists on disk before
      // FileBrowser tries to resolve it. linkDaemonTeamWorkspace is idempotent.
      if (workspacePath) {
        try {
          await linkDaemonTeamWorkspace(workspacePath)
        } catch {
          // Non-fatal: FileBrowser will fall back to an empty tree if the link
          // is missing; the dir-state hint still tells the user to sync.
        }
      }
      setDirState('populated')
    }
  }, [globalPath, workspacePath])

  React.useEffect(() => {
    let cancelled = false
    setDirState('loading')
    void (async () => {
      try {
        await resolveDirState()
      } catch {
        if (!cancelled) {
          setTeamRootPath(null)
          setDirState('missing')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [resolveDirState])

  const isGitShare =
    shareMode === 'managed_git' || shareMode === 'custom_git'

  const isOssShare = shareMode === 'oss'

  const handleGitSync = React.useCallback(async () => {
    if (!isTauri() || syncing || !workspacePath) return
    setSyncing(true)
    useTeamModeStore.setState({ teamGitSyncing: true })
    try {
      if (teamId) {
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
      const result = await invoke<{
        success: boolean
        message: string
      }>('team_shared_git_sync', {
        config: { workspacePath },
        force: false,
      })
      if (result.success) {
        toast.success(result.message)
        useTeamModeStore.setState({ teamGitLastSyncAt: new Date().toISOString() })
        window.dispatchEvent(new CustomEvent(TEAM_SYNCED_EVENT))
        await refreshFileTree()
        await resolveDirState()
        await useTeamModeStore.getState().loadTeamGitFileSyncStatus(workspacePath)
      } else {
        toast.error(result.message)
      }
    } catch (err) {
      toast.error(String(err))
    } finally {
      setSyncing(false)
      useTeamModeStore.setState({ teamGitSyncing: false })
    }
  }, [syncing, refreshFileTree, resolveDirState, workspacePath, teamId, refreshShare, t])

  const handleOssSync = React.useCallback(async () => {
    if (!workspacePath || ossSyncing) return
    await ossSyncNow(workspacePath)
    await refreshFileTree()
    await resolveDirState()
  }, [workspacePath, ossSyncing, ossSyncNow, refreshFileTree, resolveDirState])

  if (!workspacePath) return null

  const iconButtonClass =
    'flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground'

  const syncBusy = syncing || ossSyncing

  const syncIcon =
    isGitShare || isOssShare ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => void (isOssShare ? handleOssSync() : handleGitSync())}
            disabled={syncBusy}
            className={iconButtonClass}
            data-testid="team-shared-sync"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', syncBusy && 'animate-spin')} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {isOssShare
            ? t('settings.team.oss.syncNow', 'Sync now')
            : t('settings.team.syncNow', 'Sync Now')}
        </TooltipContent>
      </Tooltip>
    ) : null

  const actionIcons = syncIcon ? <>{syncIcon}</> : undefined

  if (dirState === 'loading') {
    return (
      <div className="text-xs text-muted-foreground text-center py-4">
        {t('navigation.teamSharedFilesLoading', 'Loading team shared files...')}
      </div>
    )
  }

  // The global team share dir does not exist on disk yet — the daemon has not
  // materialized it (e.g. first sync hasn't run). Surface an error + a hint to
  // sync rather than silently showing an empty tree.
  if (dirState === 'missing') {
    return (
      <div className="flex flex-col items-center gap-2 text-center py-6 px-3">
        <AlertCircle className="h-5 w-5 text-destructive" />
        <div className="text-xs text-muted-foreground">
          {t(
            'navigation.teamSharedFilesDirMissing',
            'Team shared directory does not exist yet. Sync to fetch it from the team.',
          )}
        </div>
        {teamRootPath && (
          <div className="text-[10.5px] font-mono text-faint break-all">{teamRootPath}</div>
        )}
        {syncIcon && <div className="mt-1">{syncIcon}</div>}
      </div>
    )
  }

  // Directory exists but is empty — nothing has been shared yet.
  if (dirState === 'empty') {
    return (
      <div className="flex flex-col items-center gap-2 text-center py-6 px-3">
        <Info className="h-5 w-5 text-muted-foreground" />
        <div className="text-xs text-muted-foreground">
          {t('navigation.teamSharedFilesEmpty', 'This team shared directory is empty.')}
        </div>
        {syncIcon && <div className="mt-1">{syncIcon}</div>}
      </div>
    )
  }

  // FileBrowser renders via the workspace-scoped file commands, which reject
  // paths outside the workspace. `teamRootPath` is the daemon-owned global dir
  // (outside the workspace), so we render through the in-workspace
  // `teamclaw-team` symlink that points at it. The global path stays in use for
  // the dir-state existence checks above (those go through the unscoped fs
  // plugin, not the workspace commands).
  const teamRenderPath = `${workspacePath}/${TEAM_SHARE_LINK_DIR}`

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <FileBrowser
        variant="panel"
        rootPath={teamRenderPath}
        hideGitStatus={false}
        hideToolbar={hidePanelToolbar}
        filterText={filterText}
        onFilterTextChange={onFilterTextChange}
        gitChangedOnly={gitChangedOnly}
        onGitChangedOnlyChange={onGitChangedOnlyChange}
        searchExpanded={searchExpanded}
        onSearchExpandedChange={onSearchExpandedChange}
        actionIcons={actionIcons}
      />
    </div>
  )
}
