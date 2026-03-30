import * as React from 'react'
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"
import { Search, GitBranch, ChevronsDownUp, Undo2, LocateFixed } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { useFileChangeListener } from '@/hooks/useFileChangeListener'
import { useWorkspaceStore } from '@/stores/workspace'
import { ScrollBar } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FileTree } from './FileTree'


interface FileBrowserProps {
  className?: string
  // 'default' - shows header with workspace name (for right panel)
  // 'panel' - no header, for file mode left panel (header handled by parent)
  variant?: 'default' | 'panel'
}

export function FileBrowser({ className, variant = 'default' }: FileBrowserProps) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const isPanelOpen = useWorkspaceStore(s => s.isPanelOpen)
  const fileTree = useWorkspaceStore(s => s.fileTree)
  const refreshFileTree = useWorkspaceStore(s => s.refreshFileTree)
  const collapseAll = useWorkspaceStore(s => s.collapseAll)
  const undo = useWorkspaceStore(s => s.undo)
  const undoStack = useWorkspaceStore(s => s.undoStack)
  const [filterText, setFilterText] = React.useState('')
  const deferredFilterText = React.useDeferredValue(filterText)
  const [gitChangedOnly, setGitChangedOnly] = React.useState(false)

  // Auto-refresh file tree when panel opens (default variant) or when mounted (panel variant)
  React.useEffect(() => {
    const shouldRefresh = variant === 'panel'
      ? workspacePath && fileTree.length === 0
      : isPanelOpen && workspacePath && fileTree.length === 0

    if (shouldRefresh) {
      console.log('[FileBrowser] Auto-refreshing file tree for:', workspacePath)
      refreshFileTree()
    }
  }, [variant, isPanelOpen, workspacePath, fileTree.length, refreshFileTree])

  // Listen for file-change events from Tauri file watcher
  useFileChangeListener(() => refreshFileTree(), 300, !!workspacePath)

  // Ctrl/Cmd+Z undo handler
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        // Only handle when file browser is focused (or its descendants)
        const el = document.activeElement
        const isInFileBrowser = el?.closest('[data-file-browser]')
        if (!isInFileBrowser) return

        e.preventDefault()
        if (undoStack.length === 0) return
        const lastOp = undoStack[undoStack.length - 1]
        undo().then((success) => {
          if (success) {
            toast.success(t('fileExplorer.undone', 'Undone: {{desc}}', { desc: lastOp.description }))
          } else {
            toast.error(t('fileExplorer.undoFailed', 'Cannot undo this operation'))
          }
        })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [undo, undoStack, t])

  const handleUndo = React.useCallback(async () => {
    if (undoStack.length === 0) return
    const lastOp = undoStack[undoStack.length - 1]
    const success = await undo()
    if (success) {
      toast.success(t('fileExplorer.undone', 'Undone: {{desc}}', { desc: lastOp.description }))
    } else {
      toast.error(t('fileExplorer.undoFailed', 'Cannot undo this operation'))
    }
  }, [undo, undoStack, t])

  return (
    <div className={cn('flex flex-col h-full', className)} data-file-browser data-testid="file-browser">
      {/* Filter input */}
      <div className="px-2 py-1.5 border-b">
        <div className="flex items-center gap-1">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              type="text"
              placeholder={t('fileExplorer.filterPlaceholder', 'Filter files...')}
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="pl-7 h-7 text-xs"
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setGitChangedOnly(!gitChangedOnly)}
                className={cn(
                  'flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0',
                  gitChangedOnly
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {gitChangedOnly
                ? t('fileExplorer.showAll', 'Show all files')
                : t('fileExplorer.showGitChanged', 'Show git changed files only')}
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
            <TooltipContent side="bottom">
              {t('fileExplorer.collapseAll', 'Collapse All')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  const selectedFile = useWorkspaceStore.getState().selectedFile;
                  if (selectedFile) {
                    useWorkspaceStore.getState().revealFile(selectedFile).catch(() => {});
                  }
                }}
                className="flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <LocateFixed className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('fileExplorer.revealActiveFile', 'Reveal Active File')}
            </TooltipContent>
          </Tooltip>
          {undoStack.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleUndo}
                  className="flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('fileExplorer.undo', 'Undo: {{desc}}', { desc: undoStack[undoStack.length - 1]?.description })}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      {/* File tree - supports horizontal and vertical scroll */}
      <ScrollAreaPrimitive.Root className="flex-1 relative overflow-hidden">
        <ScrollAreaPrimitive.Viewport className="h-full w-full">
          <div className="py-1 min-w-max">
            <FileTree filterText={deferredFilterText} gitChangedOnly={gitChangedOnly} />
          </div>
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar orientation="vertical" />
        <ScrollBar orientation="horizontal" />
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
    </div>
  )
}
