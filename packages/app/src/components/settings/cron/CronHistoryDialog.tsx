/**
 * CronHistoryDialog - Run history dialog and record card.
 * Extracted from CronSection.tsx.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Clock,
  AlertCircle,
  CheckCircle2,
  Loader2,
  History,
  Send,
  GitBranch,
  MessageSquare,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useSessionStore } from '@/stores/session'
import { useUIStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTabsStore } from '@/stores/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  useCronStore,
  formatRelativeTime,
  getRunStatusColor,
  type CronJob,
  type CronRunRecord,
} from '@/stores/cron'

function RunRecordCard({ run, onViewSession }: { run: CronRunRecord; onViewSession?: (sessionId: string) => void }) {
  const statusColor = getRunStatusColor(run.status)
  const duration =
    run.startedAt && run.finishedAt
      ? (
          (new Date(run.finishedAt).getTime() -
            new Date(run.startedAt).getTime()) /
          1000
        ).toFixed(1) + 's'
      : '...'

  return (
    <div className="rounded-lg border p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {run.status === 'success' && (
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          )}
          {run.status === 'failed' && (
            <AlertCircle className="h-4 w-4 text-red-500" />
          )}
          {run.status === 'timeout' && (
            <Clock className="h-4 w-4 text-orange-500" />
          )}
          {run.status === 'running' && (
            <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
          )}
          <span className={cn('text-sm font-medium capitalize', statusColor)}>
            {run.status}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{formatRelativeTime(run.startedAt)}</span>
          <span>{duration}</span>
        </div>
      </div>

      {run.responseSummary && (
        <p className="text-xs text-muted-foreground line-clamp-3 bg-muted/30 rounded p-2">
          {run.responseSummary}
        </p>
      )}

      {run.deliveryStatus && (
        <p className="text-xs text-muted-foreground">
          <Send className="h-3 w-3 inline mr-1" />
          {run.deliveryStatus}
        </p>
      )}

      {run.worktreePath && (
        <p className="text-xs text-muted-foreground">
          <GitBranch className="h-3 w-3 inline mr-1" />
          {run.worktreePath}
        </p>
      )}

      {run.error && (
        <p className="text-xs text-destructive">
          <AlertCircle className="h-3 w-3 inline mr-1" />
          {run.error}
        </p>
      )}

      {run.sessionId && onViewSession && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => onViewSession(run.sessionId!)}
        >
          <MessageSquare className="h-3 w-3 mr-1" />
          查看对话
        </Button>
      )}
    </div>
  )
}

export function CronHistoryDialog({
  open,
  onOpenChange,
  job,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  job: CronJob | null
}) {
  const { t } = useTranslation()
  const { runs, runsLoading, loadRuns } = useCronStore()
  const setActiveSession = useSessionStore(s => s.setActiveSession)
  const closeSettings = useUIStore(s => s.closeSettings)
  const clearSelection = useWorkspaceStore(s => s.clearSelection)

  const handleViewSession = React.useCallback(async (sessionId: string) => {
    clearSelection()
    useTabsStore.getState().hideAll()
    await setActiveSession(sessionId)
    closeSettings()
    onOpenChange(false)
  }, [clearSelection, setActiveSession, closeSettings, onOpenChange])

  React.useEffect(() => {
    if (open && job) {
      loadRuns(job.id)
    }
  }, [open, job?.id])

  if (!job) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            {t('settings.cron.runHistory', 'Run History')}: {job.name}
          </DialogTitle>
          <DialogDescription>
            {t('settings.cron.runHistoryDesc', 'Recent execution history for this job.')}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[55vh]">
          {runsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : runs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <History className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">{t('settings.cron.noRunHistory', 'No run history yet')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {runs.map((run) => (
                <RunRecordCard key={run.runId} run={run} onViewSession={handleViewSession} />
              ))}
            </div>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
