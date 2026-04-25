import React from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamModeStore } from '@/stores/team-mode'
import { isTauri } from '@/lib/utils'

interface KnowledgeBrowserProps {
  hidePanelToolbar?: boolean
  filterText?: string
  onFilterTextChange?: (value: string) => void
  gitChangedOnly?: boolean
  onGitChangedOnlyChange?: (value: boolean) => void
  searchExpanded?: boolean
  onSearchExpandedChange?: (value: boolean) => void
}

export function KnowledgeBrowser({
  hidePanelToolbar = false,
  filterText,
  onFilterTextChange,
  gitChangedOnly,
  onGitChangedOnlyChange,
  searchExpanded,
  onSearchExpandedChange,
}: KnowledgeBrowserProps = {}) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const refreshFileTree = useWorkspaceStore(s => s.refreshFileTree)

  const teamModeType = useTeamModeStore(s => s.teamModeType)
  const [syncing, setSyncing] = React.useState(false)

  const handleGitSync = React.useCallback(async () => {
    if (!isTauri() || syncing) return
    setSyncing(true)
    useTeamModeStore.setState({ teamGitSyncing: true })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke<{
        success: boolean
        message: string
        needsConfirmation?: boolean
        newFiles?: Array<{ path: string; sizeBytes: number }>
        totalBytes?: number
      }>('team_sync_repo', { force: false, workspacePath })
      if (result.needsConfirmation) {
        toast.warning(
          `检测到 ${result.newFiles?.length ?? 0} 个较大的新文件待同步，请在设置 → 团队中确认`,
        )
        return
      }
      if (result.success) {
        toast.success(result.message)
        useTeamModeStore.setState({ teamGitLastSyncAt: new Date().toISOString() })
        await refreshFileTree()
        if (workspacePath) {
          await useTeamModeStore.getState().loadTeamGitFileSyncStatus(workspacePath)
        }
      } else {
        toast.error(result.message)
      }
    } catch (err) {
      toast.error(String(err))
    } finally {
      setSyncing(false)
      useTeamModeStore.setState({ teamGitSyncing: false })
    }
  }, [syncing, refreshFileTree, workspacePath])

  if (!workspacePath) return null

  const iconButtonClass = 'flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground'

  const gitSyncIcon = teamModeType === 'git' ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button onClick={handleGitSync} disabled={syncing} className={iconButtonClass}>
          <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t('knowledge.gitSync', 'Sync Team')}</TooltipContent>
    </Tooltip>
  ) : null

  const actionIcons = gitSyncIcon ? (<>{gitSyncIcon}</>) : undefined

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <FileBrowser
        variant="panel"
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
