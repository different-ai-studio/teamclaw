import { useState } from 'react'
import { FileCode, ChevronDown, ChevronRight } from 'lucide-react'
import type { FileDiff } from '@/lib/opencode/types'

interface SessionDiffPanelProps {
  diff: FileDiff[]
  compact?: boolean
}

export function SessionDiffPanel({ diff, compact: _compact }: SessionDiffPanelProps) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())

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
