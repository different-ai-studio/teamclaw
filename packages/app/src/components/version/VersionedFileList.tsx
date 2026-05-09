import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { VersionedFileInfo } from '@/stores/version-history'

const DOC_TYPE_LABELS: Record<string, { key: string; fallback: string }> = {
  skill: { key: 'versionHistory.docType.skill', fallback: 'Skills' },
  mcp: { key: 'versionHistory.docType.mcp', fallback: 'MCP' },
  knowledge: { key: 'versionHistory.docType.knowledge', fallback: 'Knowledge' },
  meta: { key: 'versionHistory.docType.meta', fallback: 'Meta' },
}

const FILTER_OPTIONS: { key: string; fallback: string; value: string | null }[] = [
  { key: 'versionHistory.filterAll', fallback: 'All', value: null },
  { key: 'versionHistory.docType.skill', fallback: 'Skills', value: 'skill' },
  { key: 'versionHistory.docType.mcp', fallback: 'MCP', value: 'mcp' },
  { key: 'versionHistory.docType.knowledge', fallback: 'Knowledge', value: 'knowledge' },
  { key: 'versionHistory.docType.meta', fallback: 'Meta', value: 'meta' },
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
  const { t } = useTranslation()
  const filteredFiles = docTypeFilter
    ? files.filter((f) => f.docType === docTypeFilter)
    : files

  return (
    <div className="flex h-full flex-col">
      {/* Filter row */}
      <div className="flex flex-wrap gap-1 border-b px-3 py-2">
        {FILTER_OPTIONS.map(({ key, fallback, value }) => (
          <button
            key={key}
            onClick={() => onFilterChange(value)}
            className={cn(
              'rounded-full px-2.5 py-0.5 text-xs transition-colors',
              docTypeFilter === value
                ? 'bg-primary text-primary-foreground font-medium'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            )}
          >
            {t(key, fallback)}
          </button>
        ))}
      </div>

      {/* File list */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {filteredFiles.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              {t('versionHistory.noFiles', 'No files')}
            </div>
          )}
          {filteredFiles.map((file) => {
            const isSelected =
              selectedPath === file.path && selectedDocType === file.docType
            const fileName = getFileName(file.path)
            const docTypeLabel = DOC_TYPE_LABELS[file.docType]
            const docLabel = docTypeLabel ? t(docTypeLabel.key, docTypeLabel.fallback) : file.docType

            return (
              <div
                key={`${file.docType}:${file.path}`}
                className={cn(
                  'mx-1 cursor-pointer rounded-md px-3 py-2',
                  isSelected ? 'bg-accent font-medium' : 'hover:bg-accent/50'
                )}
                onClick={() => onSelect(file.path, file.docType)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      'truncate text-sm',
                      file.currentDeleted && 'line-through text-destructive'
                    )}
                  >
                    {fileName}
                  </span>
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-xs bg-muted text-muted-foreground">
                    {docLabel}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t('versionHistory.versionCount', { count: file.versionCount })}
                </div>
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
