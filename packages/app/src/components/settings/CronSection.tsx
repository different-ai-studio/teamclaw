import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Clock,
  Plus,
  Trash2,
  Edit2,
  Play,
  AlertCircle,
  Loader2,
  History,
  X,
  Send,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  useCronStore,
  formatSchedule,
  formatRelativeTime,
  getChannelDisplayName,
  type CronJob,
} from '@/stores/cron'
import { useWorkspaceStore } from '@/stores/workspace'
import { ToggleSwitch } from './shared'
import { getDeliveryTargetDisplay } from '@/lib/cron-utils'
import { CronJobDialog } from './cron/CronJobDialog'
import { CronHistoryDialog } from './cron/CronHistoryDialog'

// ==================== Job Card ====================

function JobCard({
  job,
  onEdit,
  onDelete,
  onToggle,
  onRun,
  onViewHistory,
}: {
  job: CronJob
  onEdit: () => void
  onDelete: () => void
  onToggle: (enabled: boolean) => void
  onRun: () => void
  onViewHistory: () => void
}) {
  const { t } = useTranslation()
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  return (
    <div
      className={cn(
        'rounded-lg border p-4 transition-all',
        job.enabled ? 'bg-card' : 'bg-muted/30 opacity-75'
      )}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <ToggleSwitch enabled={job.enabled} onChange={onToggle} />
          <h4 className="font-medium">{job.name}</h4>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground px-2 py-0.5 rounded-md bg-muted">
            {formatSchedule(job.schedule)}
          </span>
          {job.enabled ? (
            <span className="flex items-center gap-1 text-xs text-green-500">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              {t('settings.cron.active', 'Active')}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t('settings.cron.paused', 'Paused')}</span>
          )}
        </div>
      </div>

      {/* Description */}
      {job.description && (
        <p className="text-sm text-muted-foreground mb-2">{job.description}</p>
      )}

      {/* Info row */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground mb-3">
        {job.lastRunAt && (
          <span>{t('settings.cron.lastRun', 'Last run')}: {formatRelativeTime(job.lastRunAt)}</span>
        )}
        {job.nextRunAt && job.enabled && (
          <span>{t('settings.cron.nextRun', 'Next')}: {formatRelativeTime(job.nextRunAt)}</span>
        )}
        {job.delivery && (
          <span className="flex items-center gap-1">
            <Send className="h-3 w-3" />
            {getChannelDisplayName(job.delivery.channel)} &rarr; {getDeliveryTargetDisplay(job.delivery)}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onRun}
          disabled={!job.enabled}
          className="h-7 text-xs"
        >
          <Play className="h-3 w-3 mr-1" />
          {t('settings.cron.runNow', 'Run Now')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onEdit}
          className="h-7 text-xs"
        >
          <Edit2 className="h-3 w-3 mr-1" />
          {t('settings.cron.edit', 'Edit')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onViewHistory}
          className="h-7 text-xs"
        >
          <History className="h-3 w-3 mr-1" />
          {t('settings.cron.history', 'History')}
        </Button>
        {confirmDelete ? (
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-xs text-destructive">{t('settings.cron.confirm', 'Confirm?')}</span>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                onDelete()
                setConfirmDelete(false)
              }}
              className="h-7 text-xs"
            >
              {t('fileExplorer.delete', 'Delete')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              className="h-7 text-xs"
            >
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            className="h-7 text-xs ml-auto text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  )
}

// ==================== Main CronSection ====================

export function CronSection() {
  const { t } = useTranslation()
  const { jobs, isLoading, error, reinit, loadJobs, removeJob, toggleEnabled, runJob, clearError } =
    useCronStore()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  const [formOpen, setFormOpen] = React.useState(false)
  const [editJob, setEditJob] = React.useState<CronJob | undefined>(undefined)
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [historyJob, setHistoryJob] = React.useState<CronJob | null>(null)

  // Initialize when workspace is ready or changes.
  // Using workspacePath as the trigger ensures we only init after workspace is loaded,
  // and automatically reinit when workspace changes.
  React.useEffect(() => {
    if (workspacePath) {
      // Always use reinit() which bypasses the isInitialized guard.
      // For first load, backend will skip the stop() since scheduler isn't running yet.
      // For workspace changes, backend will stop old scheduler before starting new one.
      reinit()
    }
  }, [workspacePath])

  // Refresh jobs periodically (every 30 seconds)
  React.useEffect(() => {
    const interval = setInterval(() => {
      loadJobs()
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  const handleOpenCreate = () => {
    setEditJob(undefined)
    setFormOpen(true)
  }

  const handleOpenEdit = (job: CronJob) => {
    setEditJob(job)
    setFormOpen(true)
  }

  const handleViewHistory = (job: CronJob) => {
    setHistoryJob(job)
    setHistoryOpen(true)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4 mb-6">
        <div className="rounded-xl p-3 bg-muted/50">
          <Clock className="h-6 w-6 text-amber-500" />
        </div>
        <div className="flex-1">
          <h3 className="text-xl font-semibold tracking-tight">{t('settings.cron.automation', 'Automation')}</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {t('settings.cron.automationDesc', 'Schedule recurring tasks for your AI agent. Jobs run automatically and can deliver results through configured channels.')}
          </p>
        </div>
        <Button onClick={handleOpenCreate} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          {t('settings.cron.newJob', 'New Job')}
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4" />
          <span className="flex-1">{error}</span>
          <Button variant="ghost" size="sm" onClick={clearError} className="h-6 w-6 p-0">
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Loading */}
      {isLoading && jobs.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Empty State */}
      {!isLoading && jobs.length === 0 && (
        <div className="text-center py-12 rounded-xl border border-dashed">
          <Clock className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
          <h4 className="text-lg font-medium mb-2">{t('settings.cron.noJobs', 'No scheduled jobs yet')}</h4>
          <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
            {t('settings.cron.noJobsDesc', 'Create your first automated task to have your AI agent perform actions on a schedule. For example, check your approval platform every 30 minutes.')}
          </p>
          <Button onClick={handleOpenCreate}>
            <Plus className="h-4 w-4 mr-1" />
            {t('settings.cron.createFirstJob', 'Create Your First Job')}
          </Button>
        </div>
      )}

      {/* Job List */}
      {jobs.length > 0 && (
        <div className="space-y-3">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onEdit={() => handleOpenEdit(job)}
              onDelete={() => removeJob(job.id)}
              onToggle={(enabled) => toggleEnabled(job.id, enabled)}
              onRun={() => runJob(job.id)}
              onViewHistory={() => handleViewHistory(job)}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      <CronJobDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open)
          if (!open) {
            setEditJob(undefined)
            // Refresh jobs after form closes
            loadJobs()
          }
        }}
        editJob={editJob}
      />

      <CronHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        job={historyJob}
      />
    </div>
  )
}
