import React from 'react'
import { useTranslation } from 'react-i18next'
import { FilePlus, FolderPlus, Layers } from 'lucide-react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import { useWorkspaceStore } from '@/stores/workspace'
import { useKnowledgeStore } from '@/stores/knowledge'
import { useTeamModeStore } from '@/stores/team-mode'
import { cn } from '@/lib/utils'

export function KnowledgeBrowser() {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const refreshFileTree = useWorkspaceStore(s => s.refreshFileTree)
  const selectFile = useWorkspaceStore(s => s.selectFile)
  const createNoteFromLink = useKnowledgeStore(s => s.createNoteFromLink)
  const devUnlocked = useTeamModeStore(s => s.devUnlocked)

  const [rootCreating, setRootCreating] = React.useState<'file' | 'folder' | null>(null)
  const [showAll, setShowAll] = React.useState(false)

  const knowledgePath = workspacePath ? `${workspacePath}/knowledge` : undefined

  // Reset showAll when dev mode is disabled
  React.useEffect(() => {
    if (!devUnlocked) setShowAll(false)
  }, [devUnlocked])

  const handleCreateConfirm = React.useCallback(async (name: string) => {
    if (!knowledgePath) return
    const type = rootCreating
    setRootCreating(null)
    try {
      if (type === 'file') {
        const filePath = await createNoteFromLink(name)
        selectFile(filePath)
      } else {
        const { mkdir } = await import('@tauri-apps/plugin-fs')
        await mkdir(`${knowledgePath}/${name}`, { recursive: true })
        await refreshFileTree()
      }
    } catch (err) {
      const key = type === 'file' ? 'knowledge.newNoteError' : 'knowledge.newFolderError'
      const fallback = type === 'file'
        ? 'Failed to create note: {{err}}'
        : 'Failed to create folder: {{err}}'
      toast.error(t(key, fallback, { err: String(err) }))
    }
  }, [knowledgePath, rootCreating, createNoteFromLink, selectFile, refreshFileTree, t])

  const handleCreateCancel = React.useCallback(() => {
    setRootCreating(null)
  }, [])

  if (!knowledgePath) return null

  const iconButtonClass = 'flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground'

  const actionIcons = (
    <>
      {/* New Note / New Folder — only visible when showing knowledge root */}
      {!showAll && (
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
      )}

      {/* Dev-only: toggle all-workspace view */}
      {devUnlocked && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setShowAll(v => !v)}
              className={cn(
                iconButtonClass,
                showAll && 'bg-primary/10 text-primary',
              )}
            >
              <Layers className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {showAll
              ? t('knowledge.showKnowledgeOnly', 'Show knowledge only')
              : t('knowledge.showAllFiles', 'Show all workspace files')}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  )

  return (
    <FileBrowser
      variant="panel"
      rootPath={showAll ? (workspacePath ?? undefined) : knowledgePath}
      hideGitStatus={!showAll}
      actionIcons={actionIcons}
      rootCreating={showAll ? undefined : rootCreating}
      onRootCreateConfirm={handleCreateConfirm}
      onRootCreateCancel={handleCreateCancel}
    />
  )
}
