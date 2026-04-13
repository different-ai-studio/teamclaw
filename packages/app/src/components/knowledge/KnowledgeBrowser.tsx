import React from 'react'
import { useTranslation } from 'react-i18next'
import { FilePlus, FolderPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import { useWorkspaceStore } from '@/stores/workspace'
import { useKnowledgeStore } from '@/stores/knowledge'
import { useTeamModeStore } from '@/stores/team-mode'
import { useUIStore } from '@/stores/ui'
import { TEAM_REPO_DIR } from '@/lib/build-config'

export function KnowledgeBrowser() {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const teamMode = useTeamModeStore(s => s.teamMode)
  const advancedMode = useUIStore(s => s.advancedMode)
  const refreshFileTree = useWorkspaceStore(s => s.refreshFileTree)
  const selectFile = useWorkspaceStore(s => s.selectFile)
  const createNoteFromLink = useKnowledgeStore(s => s.createNoteFromLink)

  const [rootCreating, setRootCreating] = React.useState<'file' | 'folder' | null>(null)

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
    </>
  ) : undefined

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <FileBrowser
        variant="panel"
        rootPath={rootPath}
        rootPaths={rootPaths}
        rootLabels={rootLabels}
        hideGitStatus={!showFullTree}
        actionIcons={actionIcons}
        rootCreating={showFullTree ? undefined : rootCreating}
        onRootCreateConfirm={handleCreateConfirm}
        onRootCreateCancel={() => setRootCreating(null)}
      />
    </div>
  )
}
