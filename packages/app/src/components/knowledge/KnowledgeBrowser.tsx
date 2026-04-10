import React from 'react'
import { useTranslation } from 'react-i18next'
import { FilePlus, FolderPlus, ChevronsDownUp } from 'lucide-react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import { useWorkspaceStore } from '@/stores/workspace'
import { useKnowledgeStore } from '@/stores/knowledge'

export function KnowledgeBrowser() {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const collapseAll = useWorkspaceStore(s => s.collapseAll)
  const createNoteFromLink = useKnowledgeStore(s => s.createNoteFromLink)
  const selectFile = useWorkspaceStore(s => s.selectFile)

  const knowledgePath = workspacePath ? `${workspacePath}/knowledge` : undefined

  const handleNewNote = React.useCallback(async () => {
    const name = prompt(t('knowledge.newNoteName', 'Note name'))
    if (!name) return
    try {
      const filePath = await createNoteFromLink(name)
      selectFile(filePath)
    } catch (err) {
      toast.error(t('knowledge.newNoteError', 'Failed to create note: {{err}}', { err: String(err) }))
    }
  }, [createNoteFromLink, selectFile, t])

  const handleNewFolder = React.useCallback(async () => {
    const name = prompt(t('knowledge.newFolderName', 'Folder name'))
    if (!name || !knowledgePath) return
    try {
      const { mkdir } = await import('@tauri-apps/plugin-fs')
      await mkdir(`${knowledgePath}/${name}`, { recursive: true })
    } catch (err) {
      toast.error(t('knowledge.newFolderError', 'Failed to create folder: {{err}}', { err: String(err) }))
    }
  }, [knowledgePath, t])

  if (!knowledgePath) return null

  const toolbar = (
    <div className="flex items-center gap-0.5 px-2 py-1 border-b">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleNewNote}
            className="flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <FilePlus className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('knowledge.newNote', 'New Note')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleNewFolder}
            className="flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('knowledge.newFolder', 'New Folder')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={collapseAll}
            className="flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronsDownUp className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('knowledge.collapseAll', 'Collapse All')}</TooltipContent>
      </Tooltip>
    </div>
  )

  return (
    <FileBrowser
      variant="panel"
      rootPath={knowledgePath}
      hideGitStatus
      toolbar={toolbar}
    />
  )
}
