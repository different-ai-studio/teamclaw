import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { VersionedFileInfo } from '@/stores/version-history'

const DOC_TYPE_LABELS: Record<string, string> = {
  skill: 'Skills',
  mcp: 'MCP',
  knowledge: 'Knowledge',
}

const FILTER_OPTIONS: { label: string; value: string | null }[] = [
  { label: '全部', value: null },
  { label: 'Skills', value: 'skill' },
  { label: 'MCP', value: 'mcp' },
  { label: 'Knowledge', value: 'knowledge' },
]

function getFileName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath
}

interface VersionedFileListProps {
  files: VersionedFileInfo[]
  selectedPath: string | null
  selectedDocType: string | null
  onSelect: (path: string, docType: string) => void
  docTypeFilter: string | null
  onFilterChange: (filter: string | null) => void
}

export function VersionedFileList({
  files,
  selectedPath,
  selectedDocType,
  onSelect,
  docTypeFilter,
  onFilterChange,
}: VersionedFileListProps) {
  const filteredFiles = docTypeFilter
    ? files.filter((f) => f.docType === docTypeFilter)
    : files

  return (
    <div className="flex h-full flex-col">
      {/* Filter row */}
      <div className="flex flex-wrap gap-1 border-b px-3 py-2">
        {FILTER_OPTIONS.map(({ label, value }) => (
          <button
            key={label}
            onClick={() => onFilterChange(value)}
            className={cn(
              'rounded-full px-2.5 py-0.5 text-xs transition-colors',
              docTypeFilter === value
                ? 'bg-primary text-primary-foreground font-medium'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* File list */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {filteredFiles.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">暂无文件</div>
          )}
          {filteredFiles.map((file) => {
            const isSelected =
              selectedPath === file.filePath && selectedDocType === file.docType
            const fileName = getFileName(file.filePath)
            const docLabel = DOC_TYPE_LABELS[file.docType] ?? file.docType

            return (
              <div
                key={`${file.docType}:${file.filePath}`}
                className={cn(
                  'mx-1 cursor-pointer rounded-md px-3 py-2',
                  isSelected ? 'bg-accent font-medium' : 'hover:bg-accent/50'
                )}
                onClick={() => onSelect(file.filePath, file.docType)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      'truncate text-sm',
                      file.isDeleted && 'line-through text-destructive'
                    )}
                  >
                    {fileName}
                  </span>
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-xs bg-muted text-muted-foreground">
                    {docLabel}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {file.versionCount} 个版本
                </div>
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
