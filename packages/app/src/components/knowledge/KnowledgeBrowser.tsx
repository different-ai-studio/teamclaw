import React from 'react'
import { useTranslation } from 'react-i18next'
import { FilePlus, FolderPlus, ArrowUpDown, ChevronsDownUp } from 'lucide-react'
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
  const [sortByTime, setSortByTime] = React.useState(false)

  const knowledgePath = workspacePath ? `${workspacePath}/knowledge` : undefined

  const handleNewNote = React.useCallback(async () => {
    const name = prompt(t('knowledge.newNoteName', 'Note name'))
    if (!name) return
    const filePath = await createNoteFromLink(name)
    selectFile(filePath)
  }, [createNoteFromLink, selectFile, t])

  const handleNewFolder = React.useCallback(async () => {
    const name = prompt(t('knowledge.newFolderName', 'Folder name'))
    if (!name || !knowledgePath) return
    const { mkdir } = await import('@tauri-apps/plugin-fs')
    await mkdir(`${knowledgePath}/${name}`, { recursive: true })
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
            onClick={() => setSortByTime(!sortByTime)}
            className={`flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0 ${
              sortByTime ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {sortByTime ? t('knowledge.sortByName', 'Sort by name') : t('knowledge.sortByTime', 'Sort by modified time')}
        </TooltipContent>
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
