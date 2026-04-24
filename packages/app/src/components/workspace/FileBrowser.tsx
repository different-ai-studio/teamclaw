import * as React from 'react'
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"
import { Search, GitBranch, ChevronsDownUp, Undo2, LocateFixed, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { useFileChangeListener } from '@/hooks/useFileChangeListener'
import { useWorkspaceStore, type FileNode } from '@/stores/workspace'
import { ScrollBar } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FileTree } from './FileTree'


/** Find subtree children for a given path in a file tree */
function findSubtree(nodes: FileNode[], target: string): FileNode[] | undefined {
  for (const node of nodes) {
    if (node.path === target) return node.children
    if (node.children) {
      const found = findSubtree(node.children, target)
      if (found !== undefined) return found
    }
  }
  return undefined
}

interface FileBrowserProps {
  className?: string
  // 'default' - shows header with workspace name (for right panel)
  // 'panel' - single merged toolbar row with collapsible search
  variant?: 'default' | 'panel'
  /** Override root directory. Defaults to workspace root. */
  rootPath?: string
  /** Multiple root directories rendered as top-level folders in a single tree. Takes precedence over rootPath. */
  rootPaths?: string[]
  /** Display labels for rootPaths entries (same order). Falls back to directory basename. */
  rootLabels?: string[]
  /** Hide git status indicators and git-specific toolbar buttons */
  hideGitStatus?: boolean
  /** Extra action icons shown in the panel toolbar's collapsed state (e.g. New Note, New Folder) */
  actionIcons?: React.ReactNode
  /** When set, shows an InlineInput at the top of the file tree for root-level creation */
  rootCreating?: 'file' | 'folder' | null
  onRootCreateConfirm?: (name: string) => void
  onRootCreateCancel?: () => void
  /** Hide the built-in toolbar/header row, for callers rendering external controls. */
  hideToolbar?: boolean
  filterText?: string
  onFilterTextChange?: (value: string) => void
  gitChangedOnly?: boolean
  onGitChangedOnlyChange?: (value: boolean) => void
  searchExpanded?: boolean
  onSearchExpandedChange?: (value: boolean) => void
}

export function FileBrowser({ className, variant = 'default', rootPath, rootPaths, rootLabels, hideGitStatus = false, actionIcons, rootCreating, onRootCreateConfirm, onRootCreateCancel, hideToolbar = false, filterText: controlledFilterText, onFilterTextChange, gitChangedOnly: controlledGitChangedOnly, onGitChangedOnlyChange, searchExpanded: controlledSearchExpanded, onSearchExpandedChange }: FileBrowserProps) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const isPanelOpen = useWorkspaceStore(s => s.isPanelOpen)
  const fileTree = useWorkspaceStore(s => s.fileTree)
  const refreshFileTree = useWorkspaceStore(s => s.refreshFileTree)
  const collapseAll = useWorkspaceStore(s => s.collapseAll)
  const undo = useWorkspaceStore(s => s.undo)
  const undoStack = useWorkspaceStore(s => s.undoStack)
  const [internalFilterText, setInternalFilterText] = React.useState('')
  const filterText = controlledFilterText ?? internalFilterText
  const setFilterText = onFilterTextChange ?? setInternalFilterText
  const deferredFilterText = React.useDeferredValue(filterText)
  const [internalGitChangedOnly, setInternalGitChangedOnly] = React.useState(false)
  const gitChangedOnly = controlledGitChangedOnly ?? internalGitChangedOnly
  const setGitChangedOnly = onGitChangedOnlyChange ?? setInternalGitChangedOnly
  const [internalSearchExpanded, setInternalSearchExpanded] = React.useState(false)
  const searchExpanded = controlledSearchExpanded ?? internalSearchExpanded
  const setSearchExpanded = onSearchExpandedChange ?? setInternalSearchExpanded

  const isCustomRoot = !!rootPath || !!rootPaths

  // When rootPaths is provided, create virtual root folder nodes for each path.
  // When rootPath is provided, extract its subtree from the global fileTree.
  // expandDirectory keeps the global tree updated, so sub-directory expansion works naturally.
  const effectiveTree = React.useMemo(() => {
    if (rootPaths && rootPaths.length > 0) {
      return rootPaths.map((p, i) => {
        const name = rootLabels?.[i] || p.split('/').pop() || p
        const existing = findSubtree(fileTree, p)
        return {
          name,
          path: p,
          type: 'directory' as const,
          children: existing ?? [],
        }
      })
    }
    if (!rootPath) return undefined
    return findSubtree(fileTree, rootPath) ?? []
  }, [rootPaths, rootLabels, rootPath, fileTree])

  // Ensure custom rootPath(s) are present in the global tree before we try to
  // render them as virtual roots. In practice the initial attempt can race the
  // first root refresh, especially for deep team paths like teamclaw-team/knowledge.
  React.useEffect(() => {
    const expandWithAncestors = async (targetPath: string) => {
      const wp = useWorkspaceStore.getState().workspacePath
      if (!wp || !targetPath.startsWith(wp)) return
      const relative = targetPath.slice(wp.length + 1)
      const segments = relative.split('/')
      let current = wp
      for (const seg of segments) {
        current = `${current}/${seg}`
        await useWorkspaceStore.getState().expandDirectory(current)
      }
    }

    const needsLoad = (targetPath: string) => findSubtree(fileTree, targetPath) === undefined

    if (rootPaths && rootPaths.length > 0) {
      for (const p of rootPaths) {
        if (needsLoad(p)) {
          expandWithAncestors(p)
        }
      }
    } else if (rootPath && needsLoad(rootPath)) {
      expandWithAncestors(rootPath)
    }
  }, [rootPaths, rootPath, fileTree])

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

  const collapseSearchAndClear = React.useCallback(() => {
    setSearchExpanded(false)
    setFilterText('')
  }, [])

  const iconButtonClass = 'flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground'

  return (
    <div className={cn('flex flex-col h-full', className)} data-file-browser data-testid="file-browser">

      {!hideToolbar && variant === 'panel' ? (
        /* Panel variant: single merged toolbar row with collapsible search */
        <div className="flex items-center gap-0.5 px-2 py-1 border-b">
          {searchExpanded ? (
            <>
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  autoFocus
                  type="text"
                  placeholder={t('fileExplorer.filterPlaceholder', 'Filter files...')}
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') collapseSearchAndClear() }}
                  className="pl-7 h-7 text-xs"
                />
              </div>
              <button onClick={collapseSearchAndClear} className={iconButtonClass}>
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <>
              {/* Search icon — leftmost */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={() => setSearchExpanded(true)} className={iconButtonClass}>
                    <Search className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('fileExplorer.filterPlaceholder', 'Filter files...')}</TooltipContent>
              </Tooltip>

              <div className="flex-1" />

              {/* Caller-provided action icons (e.g. New Note, New Folder, Sync) */}
              {actionIcons}

              {/* Git filter — only for git-tracked directories */}
              {!hideGitStatus && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setGitChangedOnly(!gitChangedOnly)}
                      className={cn(
                        iconButtonClass,
                        gitChangedOnly && 'bg-primary/10 text-primary',
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
              )}

              {/* Collapse all */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={collapseAll} className={iconButtonClass}>
                    <ChevronsDownUp className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('fileExplorer.collapseAll', 'Collapse All')}</TooltipContent>
              </Tooltip>

              {/* Locate active file — only for git-tracked directories */}
              {!hideGitStatus && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => {
                        const selectedFile = useWorkspaceStore.getState().selectedFile
                        if (selectedFile) {
                          useWorkspaceStore.getState().revealFile(selectedFile).catch(() => {})
                        }
                      }}
                      className={iconButtonClass}
                    >
                      <LocateFixed className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t('fileExplorer.revealActiveFile', 'Reveal Active File')}</TooltipContent>
                </Tooltip>
              )}

              {/* Undo — only for git-tracked directories when undo stack is non-empty */}
              {!hideGitStatus && undoStack.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button onClick={handleUndo} className={iconButtonClass}>
                      <Undo2 className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t('fileExplorer.undo', 'Undo: {{desc}}', { desc: undoStack[undoStack.length - 1]?.description })}
                  </TooltipContent>
                </Tooltip>
              )}
            </>
          )}
        </div>
      ) : !hideToolbar ? (
        /* Default variant: original two-row layout (filter bar with all controls) */
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
      ) : null}

      {/* File tree - supports horizontal and vertical scroll */}
      <ScrollAreaPrimitive.Root className="flex-1 relative overflow-hidden">
        <ScrollAreaPrimitive.Viewport className="h-full w-full">
          <div className="py-1 min-w-max">
            <FileTree filterText={deferredFilterText} gitChangedOnly={gitChangedOnly} nodes={effectiveTree} hideGitStatus={isCustomRoot || hideGitStatus} rootCreating={rootCreating} onRootCreateConfirm={onRootCreateConfirm} onRootCreateCancel={onRootCreateCancel} />
          </div>
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar orientation="vertical" />
        <ScrollBar orientation="horizontal" />
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
    </div>
  )
}
