import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { VersionedFileInfo } from '@/stores/version-history'

function getFileName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath
}

interface VersionedFileListProps {
  files: VersionedFileInfo[]
  selectedPath: string | null
  onSelect: (path: string) => void
}

export function VersionedFileList({ files, selectedPath, onSelect }: VersionedFileListProps) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full flex-col">
      {/* File list */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {files.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              {t('versionHistory.noFiles', 'No files')}
            </div>
          )}
          {files.map((file) => {
            const isSelected = selectedPath === file.path
            const fileName = getFileName(file.path)

            return (
              <div
                key={file.path}
                className={cn(
                  'mx-1 cursor-pointer rounded-md px-3 py-2',
                  isSelected ? 'bg-accent font-medium' : 'hover:bg-accent/50'
                )}
                onClick={() => onSelect(file.path)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      'truncate text-sm',
                      file.status === 'deleted' && 'line-through text-destructive'
                    )}
                  >
                    {fileName}
                  </span>
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-xs bg-muted text-muted-foreground">
                    {file.status}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
