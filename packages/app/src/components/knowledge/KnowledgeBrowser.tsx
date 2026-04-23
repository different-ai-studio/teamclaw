import React from 'react'
import { useTranslation } from 'react-i18next'
import { FilePlus, FolderPlus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import { useWorkspaceStore } from '@/stores/workspace'
import { useKnowledgeStore } from '@/stores/knowledge'
import { useTeamModeStore } from '@/stores/team-mode'
import { useUIStore } from '@/stores/ui'
import { isTauri } from '@/lib/utils'
import { TEAM_REPO_DIR } from '@/lib/build-config'

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
  const teamMode = useTeamModeStore(s => s.teamMode)
  const advancedMode = useUIStore(s => s.advancedMode)
  const refreshFileTree = useWorkspaceStore(s => s.refreshFileTree)
  const selectFile = useWorkspaceStore(s => s.selectFile)
  const createNoteFromLink = useKnowledgeStore(s => s.createNoteFromLink)

  const teamModeType = useTeamModeStore(s => s.teamModeType)
  const [rootCreating, setRootCreating] = React.useState<'file' | 'folder' | null>(null)
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

  const personalKnowledgePath = `${workspacePath}/knowledge`
  const teamKnowledgePath = `${workspacePath}/${TEAM_REPO_DIR}/knowledge`

  // advancedMode: show full workspace tree (no rootPath)
  // teamMode (not dev): two virtual root folders for team + personal knowledge
  // otherwise: personal knowledge only
  const showFullTree = advancedMode
  const rootPaths = !showFullTree && teamMode
    ? [teamKnowledgePath, personalKnowledgePath]
    : undefined
  const rootLabels = !showFullTree && teamMode
    ? [t('knowledge.teamDocs', '团队文档'), t('knowledge.personalDocs', '个人文档')]
    : undefined
  const rootPath = showFullTree ? undefined
    : teamMode ? undefined
    : personalKnowledgePath

  const handleCreateConfirm = async (name: string) => {
    const type = rootCreating
    setRootCreating(null)
    const targetPath = personalKnowledgePath
    try {
      if (type === 'file') {
        const filePath = await createNoteFromLink(name, targetPath)
        selectFile(filePath)
      } else {
        const { mkdir } = await import('@tauri-apps/plugin-fs')
        await mkdir(`${targetPath}/${name}`, { recursive: true })
        await refreshFileTree()
      }
    } catch (err) {
      const key = type === 'file' ? 'knowledge.newNoteError' : 'knowledge.newFolderError'
      const fallback = type === 'file' ? 'Failed to create note: {{err}}' : 'Failed to create folder: {{err}}'
      toast.error(t(key, fallback, { err: String(err) }))
    }
  }

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

  const actionIcons = !showFullTree ? (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button onClick={() => setRootCreating('file')} className={iconButtonClass}>
            <FilePlus className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('knowledge.newNote', 'New Note')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button onClick={() => setRootCreating('folder')} className={iconButtonClass}>
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('knowledge.newFolder', 'New Folder')}</TooltipContent>
      </Tooltip>
      {gitSyncIcon}
    </>
  ) : gitSyncIcon ? (<>{gitSyncIcon}</>) : undefined

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <FileBrowser
        variant="panel"
        rootPath={rootPath}
        rootPaths={rootPaths}
        rootLabels={rootLabels}
        hideGitStatus={!showFullTree}
        hideToolbar={hidePanelToolbar}
        filterText={filterText}
        onFilterTextChange={onFilterTextChange}
        gitChangedOnly={gitChangedOnly}
        onGitChangedOnlyChange={onGitChangedOnlyChange}
        searchExpanded={searchExpanded}
        onSearchExpandedChange={onSearchExpandedChange}
        actionIcons={actionIcons}
        rootCreating={showFullTree ? undefined : rootCreating}
        onRootCreateConfirm={handleCreateConfirm}
        onRootCreateCancel={() => setRootCreating(null)}
      />
    </div>
  )
}
