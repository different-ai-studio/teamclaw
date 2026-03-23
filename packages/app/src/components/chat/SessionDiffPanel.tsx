import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FileCode,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Terminal,
  MessageSquarePlus,
  Undo2,
  FileText,
} from 'lucide-react'
import { toast } from 'sonner'
import type { FileDiff } from '@/lib/opencode/types'
import { copyToClipboard } from '@/lib/utils'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTabsStore } from '@/stores/tabs'
import { useVoiceInputStore } from '@/stores/voice-input'
import {
  revealInFinder,
  openInTerminal,
} from '@/components/workspace/file-tree-operations'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'

interface SessionDiffPanelProps {
  diff: FileDiff[]
  compact?: boolean
}

export function SessionDiffPanel({ diff, compact: _compact }: SessionDiffPanelProps) {
  const { t } = useTranslation()
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const openTab = useTabsStore(s => s.openTab)

  if (diff.length === 0) return null

  const toggleFile = (file: string) => {
    const newExpanded = new Set(expandedFiles)
    if (newExpanded.has(file)) {
      newExpanded.delete(file)
    } else {
      newExpanded.add(file)
    }
    setExpandedFiles(newExpanded)
  }

  const getFullPath = (relativePath: string) => {
    if (!workspacePath) return relativePath
    return `${workspacePath}/${relativePath}`
  }

  const handleOpenFile = useCallback((relativePath: string) => {
    const fullPath = getFullPath(relativePath)
    const fileName = relativePath.split('/').pop() || relativePath
    openTab({ type: 'file', target: fullPath, label: fileName })
  }, [workspacePath, openTab])

  const handleCopyPath = useCallback((relativePath: string) => {
    const fullPath = getFullPath(relativePath)
    copyToClipboard(fullPath, t('fileExplorer.pathCopied', 'Path copied'))
  }, [workspacePath, t])

  const handleCopyRelativePath = useCallback((relativePath: string) => {
    copyToClipboard(relativePath, t('fileExplorer.pathCopied', 'Path copied'))
  }, [t])

  const handleAddToAgent = useCallback((relativePath: string) => {
    useVoiceInputStore.getState().insertToChat(`@{${relativePath}} `)
  }, [])

  const handleRevealInFinder = useCallback((relativePath: string) => {
    revealInFinder(getFullPath(relativePath))
  }, [workspacePath])

  const handleOpenTerminal = useCallback((relativePath: string) => {
    const fullPath = getFullPath(relativePath)
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'))
    openInTerminal(dirPath)
  }, [workspacePath])

  const handleRevertFile = useCallback(async (relativePath: string) => {
    if (!workspacePath) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('git_checkout_file', { path: workspacePath, file: relativePath })
      toast.success(t('diff.reverted', 'File reverted'), {
        description: relativePath,
      })
    } catch (err) {
      console.error('[SessionDiffPanel] Failed to revert file:', err)
      toast.error(t('diff.revertFailed', 'Failed to revert file'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [workspacePath, t])

  const totalAdditions = diff.reduce((sum, d) => sum + d.additions, 0)
  const totalDeletions = diff.reduce((sum, d) => sum + d.deletions, 0)

  return (
    <div className="space-y-1">
      {/* Header */}
      <div className="flex items-center justify-between text-xs text-muted-foreground pb-1 mb-1 border-b">
        <span>{diff.length} files</span>
        <span className="flex items-center gap-2">
          <span className="text-green-500">+{totalAdditions}</span>
          <span className="text-red-500">-{totalDeletions}</span>
        </span>
      </div>

      {/* File list */}
      {diff.map(file => {
        const isExpanded = expandedFiles.has(file.file)
        const fileName = file.file.split('/').pop() || file.file
        const filePath = file.file.split('/').slice(0, -1).join('/')

        return (
          <div key={file.file}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  onClick={() => toggleFile(file.file)}
                  className="w-full flex items-center gap-1.5 py-1 hover:bg-muted/50 rounded transition-colors text-left"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                  )}
                  <FileCode className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                  <span className="flex-1 text-xs truncate">
                    {filePath && (
                      <span className="text-muted-foreground">{filePath}/</span>
                    )}
                    <span>{fileName}</span>
                  </span>
                  <span className="flex items-center gap-1.5 text-[10px] shrink-0">
                    <span className="text-green-500">+{file.additions}</span>
                    <span className="text-red-500">-{file.deletions}</span>
                  </span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-52">
                <ContextMenuItem onClick={() => handleOpenFile(file.file)}>
                  <FileText className="h-4 w-4" />
                  {t('diff.openFile', 'Open File')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleAddToAgent(file.file)}>
                  <MessageSquarePlus className="h-4 w-4" />
                  {t('fileExplorer.addToAgent', 'Add to Agent')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => handleCopyPath(file.file)}>
                  <Copy className="h-4 w-4" />
                  {t('fileExplorer.copyPath', 'Copy Path')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleCopyRelativePath(file.file)}>
                  <Copy className="h-4 w-4" />
                  {t('fileExplorer.copyRelativePath', 'Copy Relative Path')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  onClick={() => handleRevertFile(file.file)}
                >
                  <Undo2 className="h-4 w-4" />
                  {t('diff.revertFile', 'Revert File')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => handleOpenTerminal(file.file)}>
                  <Terminal className="h-4 w-4" />
                  {t('fileExplorer.openInTerminal', 'Open in Terminal')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleRevealInFinder(file.file)}>
                  <ExternalLink className="h-4 w-4" />
                  {t('fileExplorer.revealInFinder', 'Reveal in Finder')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>

            {isExpanded && (file.before || file.after) && (
              <div className="ml-5 mt-1 mb-2 text-[10px] font-mono bg-muted/30 rounded p-1.5 overflow-x-auto">
                {file.before && (
                  <div className="text-red-600 dark:text-red-400">
                    {file.before.split('\n').map((line, i) => (
                      <div key={`before-${i}`}>- {line}</div>
                    ))}
                  </div>
                )}
                {file.after && (
                  <div className="text-green-600 dark:text-green-400">
                    {file.after.split('\n').map((line, i) => (
                      <div key={`after-${i}`}>+ {line}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
