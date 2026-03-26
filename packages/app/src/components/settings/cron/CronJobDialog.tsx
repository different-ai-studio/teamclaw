/**
 * CronJobDialog - Create/Edit job dialog form.
 * Extracted from CronSection.tsx.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Box,
  ChevronDown,
  Loader2,
  SlidersHorizontal,
  Timer,
  Send,
  GitBranch,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  useCronStore,
  type CronJob,
  type CreateCronJobRequest,
  type UpdateCronJobRequest,
  type ScheduleKind,
  type DeliveryChannel,
} from '@/stores/cron'
import { useChannelsStore } from '@/stores/channels'
import { useProviderStore } from '@/stores/provider'
import { ToggleSwitch } from '../shared'
import {
  type JobFormState,
  defaultFormState,
  jobToFormState,
  formStateToSchedule,
  formStateToPayload,
  formStateToDelivery,
  isoToLocalDatetime,
  localDatetimeToIso,
  DELIVERY_CHANNEL_REGISTRY,
  getRegistryEntry,
} from '@/lib/cron-utils'

export function CronJobDialog({
  open,
  onOpenChange,
  editJob,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editJob?: CronJob
}) {
  const { t } = useTranslation()
  const { addJob, updateJob, runJob } = useCronStore()
  const channelsStore = useChannelsStore()
  const { models, configuredProviders, refreshConfiguredProviders } = useProviderStore()

  const [form, setForm] = React.useState<JobFormState>(defaultFormState)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [advancedOptionsOpen, setAdvancedOptionsOpen] = React.useState(false)
  const advancedScrollAnchorRef = React.useRef<HTMLDivElement>(null)

  // Load models when dialog opens
  React.useEffect(() => {
    if (open && models.length === 0) {
      refreshConfiguredProviders()
    }
  }, [open])

  React.useEffect(() => {
    if (open) {
      if (editJob) {
        const next = jobToFormState(editJob)
        setForm(next)
        setAdvancedOptionsOpen(
          next.deliveryEnabled ||
            next.useWorktree ||
            next.timeoutSeconds !== defaultFormState.timeoutSeconds,
        )
      } else {
        setForm(defaultFormState)
        setAdvancedOptionsOpen(false)
      }
      setError(null)
    }
  }, [open, editJob])

  // Scroll only when the user toggles the advanced section open (not when it opens via edit load).
  const onAdvancedOptionsOpenChange = React.useCallback((nextOpen: boolean) => {
    setAdvancedOptionsOpen(nextOpen)
    if (!nextOpen) return
    window.setTimeout(() => {
      advancedScrollAnchorRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      })
    }, 100)
  }, [])

  const update = (partial: Partial<JobFormState>) => {
    setForm((prev) => ({ ...prev, ...partial }))
  }

  // Build available channels dynamically from registry
  const availableChannels = DELIVERY_CHANNEL_REGISTRY
    .filter((entry) => entry.getEnabled(channelsStore))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      connected: entry.getConnected(channelsStore),
    }))

  const handleSave = async () => {
    if (!form.name.trim()) {
      setError(t('settings.cron.requiredName', 'Job name is required'))
      return
    }
    if (!form.message.trim()) {
      setError(t('settings.cron.requiredMessage', 'Prompt message is required'))
      return
    }
    if (form.scheduleKind === 'at' && !form.at) {
      setError(t('settings.cron.requiredDateTime', 'Date & Time is required for one-time schedule'))
      return
    }
    if (form.scheduleKind === 'cron' && !form.cronExpr.trim()) {
      setError(t('settings.cron.requiredCron', 'Cron expression is required'))
      return
    }
    if (form.deliveryEnabled) {
      const entry = getRegistryEntry(form.deliveryChannel)
      if (entry) {
        const fieldDefs = Array.isArray(entry.fields)
          ? entry.fields
          : (entry.fields[form.deliveryTargetMode] || [])
        for (const field of fieldDefs) {
          if (field.required && !form.deliveryTargetValues[field.key]?.trim()) {
            setError(`${field.label} is required`)
            return
          }
        }
      }
    }

    setSaving(true)
    setError(null)

    try {
      if (editJob) {
        const request: UpdateCronJobRequest = {
          id: editJob.id,
          name: form.name,
          description: undefined,
          enabled: form.enabled,
          schedule: formStateToSchedule(form),
          payload: formStateToPayload(form),
          delivery: form.deliveryEnabled ? formStateToDelivery(form) : null,
          deleteAfterRun: form.deleteAfterRun,
        }
        await updateJob(request)
      } else {
        const request: CreateCronJobRequest = {
          name: form.name,
          description: undefined,
          enabled: form.enabled,
          schedule: formStateToSchedule(form),
          payload: formStateToPayload(form),
          delivery: formStateToDelivery(form),
          deleteAfterRun: form.deleteAfterRun,
        }
        const newJob = await addJob(request)

        // Trigger immediate run for recurring jobs if requested
        if (
          form.runImmediately &&
          (form.scheduleKind === 'every' || form.scheduleKind === 'cron')
        ) {
          try {
            await runJob(newJob.id)
          } catch {
            // Non-fatal: job was created successfully, immediate run failed
            console.warn('[Cron] Immediate run failed, job was still created')
          }
        }
      }
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px] max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>{editJob ? t('settings.cron.editJob', 'Edit Job') : t('settings.cron.createJob', 'Create New Job')}</DialogTitle>
          <DialogDescription>
            {editJob
              ? t('settings.cron.editJobDesc', 'Modify the scheduled task configuration.')
              : t('settings.cron.createJobDesc', 'Set up a new automated task for your AI agent.')}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-4">
          <div className="space-y-6 py-2">
            {/* Section 1: Basic Info */}
            <div className="space-y-3">
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings.cron.name', 'Name')} *</label>
                <Input
                  value={form.name}
                  onChange={(e) => update({ name: e.target.value })}
                  placeholder={t('settings.cron.namePlaceholder', 'e.g., Approval Checker')}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings.cron.prompt', 'Prompt')} *</label>
                <div
                  className={cn(
                    'rounded-md border border-input bg-background shadow-xs overflow-hidden',
                    'focus-within:border-ring focus-within:ring-[1.5px] focus-within:ring-ring/50 focus-within:ring-inset',
                  )}
                >
                  <Textarea
                    value={form.message}
                    onChange={(e) => update({ message: e.target.value })}
                    placeholder={t('settings.cron.promptPlaceholder', 'Describe what the AI agent should do...')}
                    rows={8}
                    className="resize-none min-h-[220px] rounded-none border-0 shadow-none focus-visible:ring-0 focus-visible:border-0 bg-transparent py-3"
                  />
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-border/70 px-2 py-1 bg-muted/30 dark:bg-muted/15">
                    <Box className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                    <Select
                      value={form.model || '__default__'}
                      onValueChange={(v) => update({ model: v === '__default__' ? '' : v })}
                    >
                      <SelectTrigger
                        className="h-7 min-h-7 w-fit max-w-[min(100%,18rem)] shrink justify-start gap-1 border-0 bg-transparent shadow-none font-mono text-xs py-0 pl-1 pr-0.5 hover:bg-muted/60 focus:ring-0 focus:ring-offset-0 data-[state=open]:bg-muted/60 [&_svg]:h-3 [&_svg]:w-3 [&_svg]:shrink-0"
                        title={
                          form.model
                            ? t('settings.cron.modelSelected', `Using: ${form.model}`)
                            : t('settings.cron.modelOverrideHint', 'Select a model or use workspace default.')
                        }
                      >
                        <SelectValue
                          placeholder={t('settings.cron.useDefaultModel', 'Use default model')}
                        />
                      </SelectTrigger>
                      <SelectContent className="max-h-[300px]">
                        <SelectItem value="__default__">
                          <span className="text-muted-foreground italic">
                            {t('settings.cron.useDefaultModel', 'Use default model')}
                          </span>
                        </SelectItem>
                        {configuredProviders.length === 0 && (
                          <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                            {t('settings.cron.noModels', 'No models configured. Please configure providers in LLM Settings first.')}
                          </div>
                        )}
                        {configuredProviders.map((provider) => (
                          <React.Fragment key={provider.id}>
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground border-t first:border-t-0">
                              {provider.name}
                            </div>
                            {provider.models.map((model) => (
                              <SelectItem
                                key={`${provider.id}/${model.id}`}
                                value={`${provider.id}/${model.id}`}
                                className="pl-6"
                              >
                                {model.name}
                              </SelectItem>
                            ))}
                          </React.Fragment>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </div>

            {/* Section 2: Schedule — type + mode fields on one row */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2 text-muted-foreground uppercase tracking-wide">
                <Timer className="h-3.5 w-3.5" />
                {t('settings.cron.schedule', 'Schedule')}
              </h4>
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1 min-w-0 flex-1 basis-[11rem]">
                  <label className="text-xs text-muted-foreground">
                    {t('settings.cron.scheduleType', 'Schedule Type')}
                  </label>
                  <Select
                    value={form.scheduleKind}
                    onValueChange={(v: ScheduleKind) => {
                      const updates: Partial<JobFormState> = { scheduleKind: v }
                      if (v !== 'at') {
                        updates.deleteAfterRun = false
                      }
                      if (v === 'at' && !form.at) {
                        const defaultAt = new Date(Date.now() + 30 * 60 * 1000)
                        updates.at = defaultAt.toISOString()
                      }
                      update(updates)
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="every">{t('settings.cron.intervalRecurring', 'Interval (Recurring)')}</SelectItem>
                      <SelectItem value="cron">{t('settings.cron.cronExpr', 'Cron Expression')}</SelectItem>
                      <SelectItem value="at">{t('settings.cron.oneTime', 'One-time')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {form.scheduleKind === 'every' && (
                  <>
                    <div className="space-y-1 w-[4.25rem] shrink-0">
                      <label className="text-xs text-muted-foreground">{t('settings.cron.interval', 'Interval')}</label>
                      <Input
                        type="number"
                        min={1}
                        className="tabular-nums"
                        value={form.everyValue}
                        onChange={(e) =>
                          update({ everyValue: parseInt(e.target.value, 10) || 1 })
                        }
                      />
                    </div>
                    <div className="space-y-1 min-w-[6.5rem] flex-1 basis-[6.5rem] max-w-[11rem]">
                      <label className="text-xs text-muted-foreground">{t('settings.cron.unit', 'Unit')}</label>
                      <Select
                        value={form.everyUnit}
                        onValueChange={(v: 'minutes' | 'hours' | 'days') =>
                          update({ everyUnit: v })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="minutes">{t('settings.cron.minutes', 'Minutes')}</SelectItem>
                          <SelectItem value="hours">{t('settings.cron.hours', 'Hours')}</SelectItem>
                          <SelectItem value="days">{t('settings.cron.days', 'Days')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}

                {form.scheduleKind === 'cron' && (
                  <>
                    <div className="space-y-1 min-w-0 flex-1 basis-[10rem]">
                      <label className="text-xs text-muted-foreground">
                        {t('settings.cron.cronExprLabel', 'Cron Expression')} *
                      </label>
                      <Input
                        value={form.cronExpr}
                        onChange={(e) => update({ cronExpr: e.target.value })}
                        placeholder="*/30 * * * *"
                        className="font-mono w-full"
                      />
                    </div>
                    <div className="space-y-1 min-w-[7rem] w-40 shrink-0 sm:w-44">
                      <label className="text-xs text-muted-foreground">
                        {t('settings.cron.timezone', 'Timezone (optional)')}
                      </label>
                      <Input
                        value={form.cronTz}
                        onChange={(e) => update({ cronTz: e.target.value })}
                        placeholder="Asia/Singapore"
                        className="w-full"
                      />
                    </div>
                  </>
                )}

                {form.scheduleKind === 'at' && (
                  <div className="space-y-1 min-w-0 flex-1 basis-[14rem]">
                    <label className="text-xs text-muted-foreground">{t('settings.cron.dateTime', 'Date & Time')} *</label>
                    <Input
                      type="datetime-local"
                      className="w-full"
                      value={isoToLocalDatetime(form.at)}
                      onChange={(e) => {
                        const val = e.target.value
                        update({ at: localDatetimeToIso(val) })
                      }}
                    />
                  </div>
                )}
              </div>

              {form.scheduleKind === 'every' && (
                <div className="space-y-2">
                  {!editJob && (
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="runImmediatelyEvery"
                        checked={form.runImmediately}
                        onChange={(e) => update({ runImmediately: e.target.checked })}
                        className="rounded"
                      />
                      <label htmlFor="runImmediatelyEvery" className="text-sm">
                        {t('settings.cron.runImmediately', 'Run immediately after creation')}
                      </label>
                    </div>
                  )}
                  {!form.runImmediately && !editJob && (
                    <p className="text-xs text-muted-foreground">
                      First run will be in {form.everyValue}{' '}
                      {form.everyUnit === 'minutes'
                        ? 'min'
                        : form.everyUnit === 'hours'
                          ? 'hour(s)'
                          : 'day(s)'}{' '}
                      from now.
                    </p>
                  )}
                </div>
              )}

              {form.scheduleKind === 'cron' && (
                <div className="space-y-2">
                  {!editJob && (
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="runImmediatelyCron"
                        checked={form.runImmediately}
                        onChange={(e) => update({ runImmediately: e.target.checked })}
                        className="rounded"
                      />
                      <label htmlFor="runImmediatelyCron" className="text-sm">
                        {t('settings.cron.runImmediately', 'Run immediately after creation')}
                      </label>
                    </div>
                  )}
                </div>
              )}
            </div>

            <Collapsible open={advancedOptionsOpen} onOpenChange={onAdvancedOptionsOpenChange}>
              <CollapsibleTrigger
                type="button"
                className={cn(
                  'flex w-full items-center gap-3 py-3',
                  'border-0 bg-transparent shadow-none outline-none ring-0 ring-offset-0',
                  'text-muted-foreground hover:text-foreground transition-colors',
                  'focus-visible:text-foreground',
                )}
              >
                <span className="h-px min-w-0 flex-1 bg-border" aria-hidden />
                <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                      advancedOptionsOpen && 'rotate-180',
                    )}
                    aria-hidden
                  />
                  {t('settings.cron.advancedOptions', 'Advanced options')}
                </span>
                <span className="h-px min-w-0 flex-1 bg-border" aria-hidden />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-4">
                <div ref={advancedScrollAnchorRef} className="scroll-mt-2 space-y-6">
            {/* Section 3: Execution */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2 text-muted-foreground uppercase tracking-wide">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {t('settings.cron.execution', 'Execution')}
              </h4>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings.cron.timeout', 'Timeout (seconds)')}</label>
                <Input
                  type="number"
                  min={30}
                  max={900}
                  value={form.timeoutSeconds}
                  onChange={(e) => update({ timeoutSeconds: Math.max(30, Math.min(900, Number(e.target.value) || 180)) })}
                  className="w-32"
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.cron.timeoutHint', 'Max time for AI to respond. Auto-aborts if exceeded (30-900s, default 180s).')}
                </p>
              </div>

              {/* Worktree isolation */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium">{t('settings.cron.useWorktree', 'Run in isolated worktree')}</label>
                  <p className="text-xs text-muted-foreground">
                    {t('settings.cron.useWorktreeDesc', 'Execute in a temporary git worktree copy')}
                  </p>
                </div>
                <ToggleSwitch
                  enabled={form.useWorktree}
                  onChange={(v) => update({ useWorktree: v })}
                />
              </div>

              {form.useWorktree && (
                <div className="space-y-2 pl-4 border-l-2 border-muted">
                  <label className="text-sm font-medium flex items-center gap-1.5">
                    <GitBranch className="h-3.5 w-3.5" />
                    {t('settings.cron.worktreeBranch', 'Branch')}
                  </label>
                  <Input
                    value={form.worktreeBranch}
                    onChange={(e) => update({ worktreeBranch: e.target.value })}
                    placeholder={t('settings.cron.worktreeBranchPlaceholder', 'main')}
                    className="font-mono text-xs"
                  />
                </div>
              )}
            </div>

            {/* Section 4: Delivery */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2 text-muted-foreground uppercase tracking-wide">
                <Send className="h-3.5 w-3.5" />
                {t('settings.cron.delivery', 'Delivery')}
              </h4>
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium">{t('settings.cron.enableDelivery', 'Enable Delivery')}</label>
                  <p className="text-xs text-muted-foreground">
                    {t('settings.cron.enableDeliveryDesc', 'Send results to a channel after execution')}
                  </p>
                </div>
                <ToggleSwitch
                  enabled={form.deliveryEnabled}
                  onChange={(v) => update({ deliveryEnabled: v })}
                />
              </div>

              {form.deliveryEnabled && (
                <div className="space-y-3 pl-4 border-l-2 border-muted">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('settings.cron.channel', 'Channel')}</label>
                    {availableChannels.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t('settings.cron.noChannels', 'No channels configured. Please set up a channel in the Channels section first.')}
                      </p>
                    ) : (
                      <Select
                        value={form.deliveryChannel}
                        onValueChange={(v: DeliveryChannel) =>
                          update({ deliveryChannel: v })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {availableChannels.map((ch) => (
                            <SelectItem key={ch.id} value={ch.id}>
                              <span className="flex items-center gap-2">
                                {ch.name}
                                {ch.connected ? (
                                  <span className="text-green-500 text-xs">
                                    ({t('settings.channels.connected', 'connected')})
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground text-xs">
                                    ({t('settings.channels.disconnected', 'disconnected')})
                                  </span>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>

                  {/* Dynamic channel-specific fields from registry */}
                  {(() => {
                    const entry = getRegistryEntry(form.deliveryChannel)
                    if (!entry) return null

                    const hasModes = !!entry.modes
                    const currentMode = form.deliveryTargetMode
                    const fieldDefs = Array.isArray(entry.fields)
                      ? entry.fields
                      : (entry.fields[currentMode] || [])

                    return (
                      <div className="space-y-3">
                        {hasModes && entry.modes && (
                          <div className="space-y-2">
                            <label className="text-sm font-medium">{t('settings.cron.deliveryMode', 'Delivery Mode')}</label>
                            <Select
                              value={currentMode}
                              onValueChange={(v) =>
                                update({ deliveryTargetMode: v, deliveryTargetValues: {} })
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {entry.modes.map((m) => (
                                  <SelectItem key={m.value} value={m.value}>
                                    {m.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        {fieldDefs.map((field) => (
                          <div key={field.key} className="space-y-2">
                            <label className="text-sm font-medium">
                              {field.label} {field.required && '*'}
                            </label>
                            <Input
                              type={field.type || 'text'}
                              value={form.deliveryTargetValues[field.key] || ''}
                              onChange={(e) =>
                                update({
                                  deliveryTargetValues: {
                                    ...form.deliveryTargetValues,
                                    [field.key]: e.target.value,
                                  },
                                })
                              }
                              placeholder={field.placeholder}
                              className={cn(field.type !== 'email' && 'font-mono', 'text-xs')}
                            />
                            <p className="text-xs text-muted-foreground">{field.hint}</p>
                          </div>
                        ))}
                      </div>
                    )
                  })()}

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="bestEffort"
                      checked={form.deliveryBestEffort}
                      onChange={(e) =>
                        update({ deliveryBestEffort: e.target.checked })
                      }
                      className="rounded"
                    />
                    <label htmlFor="bestEffort" className="text-sm">
                      {t('settings.cron.bestEffort', "Best effort (don't fail job if delivery fails)")}
                    </label>
                  </div>
                </div>
              )}
            </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </ScrollArea>

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive px-1">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {editJob ? t('settings.cron.saveChanges', 'Save Changes') : t('settings.cron.createJob', 'Create Job')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
