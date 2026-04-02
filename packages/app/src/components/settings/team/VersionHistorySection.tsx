import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useVersionHistoryStore } from '@/stores/version-history'
import { useWorkspaceStore } from '@/stores/workspace'
import { VersionHistoryDialog } from './VersionHistoryDialog'
import type { VersionedFileInfo } from '@/stores/version-history'
import { cn } from '@/lib/utils'

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

export function VersionHistorySection() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const { versionedFiles, loading, loadVersionedFiles } = useVersionHistoryStore()

  const [docTypeFilter, setDocTypeFilter] = useState<string | null>(null)
  const [dialogFile, setDialogFile] = useState<VersionedFileInfo | null>(null)
  const [page, setPage] = useState(0)
  const pageSize = 10

  useEffect(() => {
    if (workspacePath) {
      loadVersionedFiles(workspacePath)
    }
  }, [workspacePath, loadVersionedFiles])

  const handleFilterChange = (filter: string | null) => {
    setDocTypeFilter(filter)
    setPage(0)
    if (workspacePath) {
      loadVersionedFiles(workspacePath, filter ?? undefined)
    }
  }

  const filteredFiles = docTypeFilter
    ? versionedFiles.filter((f) => f.docType === docTypeFilter)
    : versionedFiles

  const totalPages = Math.ceil(filteredFiles.length / pageSize)
  const pagedFiles = filteredFiles.slice(page * pageSize, (page + 1) * pageSize)

  return (
    <div className="rounded-xl border border-border/40 bg-card/30 p-5 backdrop-blur-sm">
      <div className="mb-4 flex items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <h4 className="text-sm font-semibold text-foreground/90">文件版本历史</h4>
      </div>

      {/* Filter chips */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTER_OPTIONS.map(({ label, value }) => (
          <button
            key={label}
            onClick={() => handleFilterChange(value)}
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
      {loading && filteredFiles.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">加载中...</p>
      ) : filteredFiles.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">暂无文件版本记录</p>
      ) : (
        <>
          <div className="space-y-1.5">
            {pagedFiles.map((file) => {
              const fileName = getFileName(file.path)
              const docLabel = DOC_TYPE_LABELS[file.docType] ?? file.docType

              return (
                <div
                  key={`${file.docType}:${file.path}`}
                  className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'truncate text-sm font-medium',
                          file.currentDeleted && 'line-through text-destructive'
                        )}
                      >
                        {fileName}
                      </span>
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-muted text-muted-foreground">
                        {docLabel}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {file.versionCount} 个版本
                      {file.latestUpdateBy && ` · ${file.latestUpdateBy}`}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-3 h-7 shrink-0 text-xs"
                    onClick={() => setDialogFile(file)}
                  >
                    查看历史
                  </Button>
                </div>
              )
            })}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
              <span>{filteredFiles.length} 个文件</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  上一页
                </Button>
                <span>{page + 1} / {totalPages}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {dialogFile && (
        <VersionHistoryDialog
          file={dialogFile}
          onClose={() => setDialogFile(null)}
        />
      )}
    </div>
  )
}
