import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw, Clock, Database, FileText, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { isTauri } from '@/lib/utils'
import { formatTimeAgo } from '@/lib/knowledge-utils'
import { useKnowledgeStore } from '@/stores/knowledge'

export const IndexStatusPanel = React.memo(function IndexStatusPanel() {
  const { t } = useTranslation()
  const {
    indexStatus,
    isIndexing,
    indexProgress,
    loadIndexStatus,
    startIndex,
  } = useKnowledgeStore()

  const [forceReindex, setForceReindex] = React.useState(false)

  const loadStats = React.useCallback(async () => {
    if (!isTauri()) return
    await loadIndexStatus()
  }, [loadIndexStatus])

  const handleReindex = React.useCallback(async () => {
    if (!isTauri()) return
    await startIndex(undefined, false, forceReindex)
  }, [startIndex, forceReindex])

  React.useEffect(() => {
    loadStats()
  }, [loadStats])

  // Listen for knowledge index changes from file watcher
  React.useEffect(() => {
    if (!isTauri()) return

    let unlisten: (() => void) | undefined

    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event')
      unlisten = await listen('knowledge-index-changed', () => {
        console.log('[IndexStatusPanel] Knowledge index changed, refreshing status')
        loadStats()
      })
    }

    setupListener()

    return () => {
      if (unlisten) {
        unlisten()
      }
    }
  }, [loadStats])

  if (!indexStatus) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border bg-muted/30 p-3 text-center">
          <FileText className="h-4 w-4 text-muted-foreground mx-auto mb-1.5" />
          <div className="text-2xl font-bold tabular-nums">{indexStatus.totalDocuments}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {t('knowledge.stats.documents', 'Documents')}
          </div>
        </div>
        <div className="rounded-lg border bg-muted/30 p-3 text-center">
          <Layers className="h-4 w-4 text-muted-foreground mx-auto mb-1.5" />
          <div className="text-2xl font-bold tabular-nums">{indexStatus.totalChunks}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {t('knowledge.stats.chunks', 'Chunks')}
          </div>
        </div>
        <div className="rounded-lg border bg-muted/30 p-3 text-center">
          <Database className="h-4 w-4 text-muted-foreground mx-auto mb-1.5" />
          <div className="text-2xl font-bold tabular-nums">
            {indexStatus.bm25Documents}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            BM25
            {indexStatus.bm25Documents === 0 && indexStatus.totalDocuments > 0 && (
              <span className="text-destructive ml-1">{t('knowledge.stats.needsReindex')}</span>
            )}
          </div>
        </div>
      </div>

      {/* Last updated */}
      {indexStatus.lastIndexed && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          <span>
            {t('knowledge.stats.lastUpdated', 'Last Updated')}: {formatTimeAgo(indexStatus.lastIndexed, t)}
          </span>
        </div>
      )}

      {/* Index progress */}
      {indexProgress && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs rounded-lg bg-muted/50 p-3">
          <div>{t('knowledge.stats.progressIndexed', 'Indexed: {{count}} documents', { count: indexProgress.indexed })}</div>
          <div>{t('knowledge.stats.progressSkipped', 'Skipped: {{count}}', { count: indexProgress.skipped })}</div>
          <div>{t('knowledge.stats.progressFailed', 'Failed: {{count}}', { count: indexProgress.failed })}</div>
          <div>{t('knowledge.stats.progressChunks', 'Total chunks: {{count}}', { count: indexProgress.totalChunks })}</div>
          <div className="col-span-2">{t('knowledge.stats.progressDuration', 'Duration: {{ms}}ms', { ms: indexProgress.durationMs })}</div>
        </div>
      )}

      {/* Actions row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch
            id="force-reindex"
            checked={forceReindex}
            onCheckedChange={setForceReindex}
            disabled={isIndexing}
          />
          <Label
            htmlFor="force-reindex"
            className="text-xs font-normal cursor-pointer text-muted-foreground"
            title={t('knowledge.stats.forceReindexTooltip', 'Clear all vector and BM25 indexes and rebuild from scratch')}
          >
            {t('knowledge.stats.forceReindexLabel', 'Force rebuild index (clear vectors and BM25, full rebuild)')}
          </Label>
        </div>

        <Button
          onClick={handleReindex}
          disabled={isIndexing}
          size="sm"
          variant="outline"
          className="shrink-0 gap-1.5"
        >
          {isIndexing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('knowledge.stats.reindexing', 'Indexing...')}
            </>
          ) : (
            <>
              <RefreshCw className="h-3.5 w-3.5" />
              {forceReindex
                ? t('knowledge.stats.forceReindexAll', 'Force Rebuild All')
                : t('knowledge.stats.reindexAll', 'Reindex')}
            </>
          )}
        </Button>
      </div>
    </div>
  )
})
