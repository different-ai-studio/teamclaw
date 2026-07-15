import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useVersionHistoryStore } from '@/stores/version-history'
import { useCurrentTeamStore } from '@/stores/current-team'
import { VersionHistoryDialog } from './VersionHistoryDialog'
import type { VersionedFileInfo } from '@/stores/version-history'
import { cn } from '@/lib/utils'

function getFileName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath
}

export function VersionHistorySection() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id)
  const { versionedFiles, loading, loadVersionedFiles } = useVersionHistoryStore()

  const [dialogFile, setDialogFile] = useState<VersionedFileInfo | null>(null)
  const [page, setPage] = useState(0)
  const pageSize = 10

  useEffect(() => {
    if (teamId) {
      loadVersionedFiles(teamId)
    }
  }, [teamId, loadVersionedFiles])

  const totalPages = Math.ceil(versionedFiles.length / pageSize)
  const pagedFiles = versionedFiles.slice(page * pageSize, (page + 1) * pageSize)

  return (
    <div className="rounded-xl border border-border/40 bg-card/30 p-5 backdrop-blur-sm">
      <div className="mb-4 flex items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <h4 className="text-[13px] font-semibold text-foreground/90">{t('settings.team.versionHistory')}</h4>
      </div>

      {/* File list */}
      {loading && versionedFiles.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">{t('common.loading')}</p>
      ) : versionedFiles.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">{t('settings.team.noVersionHistory')}</p>
      ) : (
        <>
          <div className="space-y-1.5">
            {pagedFiles.map((file) => {
              const fileName = getFileName(file.path)

              return (
                <div
                  key={file.path}
                  className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'truncate text-[13px] font-medium',
                          file.status === 'deleted' && 'line-through text-destructive'
                        )}
                      >
                        {fileName}
                      </span>
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-muted text-muted-foreground">
                        {file.status}
                      </span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-3 h-7 shrink-0 text-xs"
                    onClick={() => setDialogFile(file)}
                  >
                    {t('settings.team.viewHistory')}
                  </Button>
                </div>
              )
            })}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
              <span>{t('settings.team.fileCount', { count: versionedFiles.length })}</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  {t('settings.team.prevPage')}
                </Button>
                <span>{page + 1} / {totalPages}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t('settings.team.nextPage')}
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
