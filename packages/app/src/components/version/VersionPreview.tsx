import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import type { FileVersion } from '@/stores/version-history'

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged'
  content: string
}

function computeSimpleDiff(oldContent: string, newContent: string): DiffLine[] {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const result: DiffLine[] = []

  // Simple line-by-line diff using LCS
  const m = oldLines.length
  const n = newLines.length

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to build diff
  const trace: DiffLine[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      trace.unshift({ type: 'unchanged', content: oldLines[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      trace.unshift({ type: 'added', content: newLines[j - 1] })
      j--
    } else {
      trace.unshift({ type: 'removed', content: oldLines[i - 1] })
      i--
    }
  }

  return trace.length > 0 ? trace : result
}

interface SimpleDiffProps {
  oldContent: string
  newContent: string
}

function SimpleDiff({ oldContent, newContent }: SimpleDiffProps) {
  const lines = computeSimpleDiff(oldContent, newContent)
  return (
    <pre className="text-xs font-mono leading-relaxed">
      {lines.map((line, idx) => (
        <div
          key={idx}
          className={cn(
            'px-3 py-px',
            line.type === 'added' && 'bg-green-500/15 text-green-700 dark:text-green-400',
            line.type === 'removed' && 'bg-red-500/15 text-red-700 dark:text-red-400',
            line.type === 'unchanged' && 'text-foreground'
          )}
        >
          <span className="mr-2 select-none text-muted-foreground">
            {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
          </span>
          {line.content}
        </div>
      ))}
    </pre>
  )
}

type TabMode = 'content' | 'diff'

interface VersionPreviewProps {
  version: FileVersion | null
  currentContent?: string
  canRestore: boolean
  onRestore: () => void
  restoring: boolean
}

export function VersionPreview({
  version,
  currentContent,
  canRestore,
  onRestore,
  restoring,
}: VersionPreviewProps) {
  const [tab, setTab] = useState<TabMode>('content')

  if (!version) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        请选择一个历史版本
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab('content')}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs transition-colors',
              tab === 'content'
                ? 'bg-accent font-medium'
                : 'text-muted-foreground hover:bg-accent/50'
            )}
          >
            内容
          </button>
          <button
            onClick={() => setTab('diff')}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs transition-colors',
              tab === 'diff'
                ? 'bg-accent font-medium'
                : 'text-muted-foreground hover:bg-accent/50'
            )}
          >
            与当前对比
          </button>
        </div>

        {canRestore && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={restoring}>
                {restoring ? '恢复中...' : '恢复此版本'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>恢复此版本？</AlertDialogTitle>
                <AlertDialogDescription>
                  文件将恢复到本地草稿，不会立即同步给团队。下次同步时，此变更将自动推送。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={onRestore}>确认恢复</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {/* Content area */}
      <ScrollArea className="flex-1">
        {tab === 'content' ? (
          <pre className="p-3 text-xs font-mono leading-relaxed whitespace-pre-wrap break-all">
            {version.content}
          </pre>
        ) : currentContent !== undefined ? (
          <SimpleDiff oldContent={currentContent} newContent={version.content} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground p-4">
            当前内容不可用
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
