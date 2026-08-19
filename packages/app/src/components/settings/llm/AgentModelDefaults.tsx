import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Box, ChevronDown, Loader2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ModelPickerCommand } from '@/components/model/ModelPickerCommand'
import { SectionHeader, SettingCard } from '../shared'
import { cn } from '@/lib/utils'
import { loadGatewayModel, saveGatewayModel } from '@/lib/amuxd-channels'
import {
  loadDeviceModelOptions,
  type DeviceModelOption,
  type DeviceModelsReason,
} from '@/lib/device-default-models'
import { getDaemonLocalAgent } from '@/lib/daemon-local-client'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useCronStore } from '@/stores/cron'
import { clientMruModels } from '@/stores/client-model-mru'
import { useAutomationDefaultModelStore } from '@/stores/automation-default-model'
import { useUIStore } from '@/stores/ui'

/**
 * Every "which model" answer on this device, in one place.
 *
 * # Why they are shown together but not merged
 *
 * The three surfaces do not share a mechanism, and pretending they do is how
 * you get the bugs each one was built to avoid:
 *
 *  - **Gateway** — a real run-time default (`channels.model`, team-scoped). It
 *    has to be: an inbound WeCom message creates a session with no form to
 *    pre-fill and nobody watching.
 *  - **Cron** — pinned per job at creation (ADR-0007). The default here is a
 *    *pre-fill for the create form only*; changing it never moves an existing
 *    job, which is the property that stopped "same job, different model on
 *    every device".
 *  - **Chat** — already answered by `client-model-mru` + `agent-model-pick-
 *    store`, whose contract warns that a second writer is what produces the
 *    "selected model keeps reverting" bug. So chat is displayed here and driven
 *    from nowhere here.
 *
 * Merging them into one stored value would either drag the MRU's feedback loop
 * back into automation, or make a cron job's model change under it. Showing
 * them together costs nothing and answers the question people actually have.
 */
export function AgentModelDefaults() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const openSettings = useUIStore((s) => s.openSettings)
  const cronJobs = useCronStore((s) => s.jobs)
  const loadCronJobs = useCronStore((s) => s.loadJobs)
  const defaultsByBackendTeam = useAutomationDefaultModelStore((s) => s.byBackendTeam)
  const setDefault = useAutomationDefaultModelStore((s) => s.setDefault)

  const [options, setOptions] = React.useState<DeviceModelOption[]>([])
  const [reason, setReason] = React.useState<DeviceModelsReason>('ok')
  const [backend, setBackend] = React.useState<string>('')
  const [gatewayModel, setGatewayModel] = React.useState<string | null>(null)
  const [gatewayOpen, setGatewayOpen] = React.useState(false)
  const [defaultOpen, setDefaultOpen] = React.useState(false)
  const [savingGateway, setSavingGateway] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await loadDeviceModelOptions(teamId).catch(() => null)
      if (cancelled) return
      if (!result) {
        setReason('failed')
        return
      }
      setOptions(result.options)
      setReason(result.reason)
      // The catalog names its own default backend; fall back to the configured
      // local agent so the store key is stable even when the catalog is empty.
      const fromCatalog = result.defaultBackend ?? result.options[0]?.backend ?? ''
      if (fromCatalog) {
        setBackend(fromCatalog)
      } else {
        const agent = await getDaemonLocalAgent().catch(() => null)
        if (!cancelled && agent) setBackend(agent)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [teamId])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const current = await loadGatewayModel()
        if (!cancelled) setGatewayModel(current)
      } catch {
        // Daemon down — the row still renders, it just cannot say what is set.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // The cron rows are a read-only summary; the section that owns them may not
  // have been opened yet, so ask for the list rather than assume it is loaded.
  React.useEffect(() => {
    void loadCronJobs().catch(() => {})
  }, [loadCronJobs])

  const pickerModels = React.useMemo(
    () =>
      options.map((o) => ({
        id: o.id,
        displayName: o.displayName,
        providerName: o.providerName,
      })),
    [options],
  )

  const emptyHint = React.useMemo(() => {
    switch (reason) {
      case 'no-default-workspace':
        return t(
          'settings.modelDefaults.noDefaultWorkspace',
          'Set a default workspace in Daemon settings first.',
        )
      case 'daemon-unavailable':
        return t('settings.modelDefaults.daemonUnavailable', 'Daemon is not ready yet. Try again shortly.')
      case 'no-models':
        return t('settings.modelDefaults.noModels', 'No models available. Configure a provider first.')
      case 'failed':
        return t('settings.modelDefaults.loadFailed', 'Failed to load models.')
      default:
        return null
    }
  }, [reason, t])

  // Read through the store map (not the imperative helper) so the row re-renders
  // when the pick changes; the helper exists for callers that cannot use hooks.
  const newJobDefault =
    backend && teamId ? (defaultsByBackendTeam[`${backend}::${teamId}`] ?? '') : ''

  const chatNext = React.useMemo(
    () => clientMruModels(backend, teamId)[0] ?? '',
    [backend, teamId],
  )

  const cronModels = React.useMemo(
    () => new Set(cronJobs.map((j) => j.payload.model?.trim()).filter(Boolean)),
    [cronJobs],
  )

  const applyGateway = async (next: string) => {
    setGatewayOpen(false)
    setSavingGateway(true)
    // Optimistic: the daemon write is one-way (no reply on the sock), so there
    // is no ack to wait for. A failed save surfaces on the next mount.
    setGatewayModel(next || null)
    try {
      await saveGatewayModel(next)
    } catch (error) {
      console.error('[AgentModelDefaults] gateway save failed', error)
    } finally {
      setSavingGateway(false)
    }
  }

  const picker = (selectedId: string, onSelect: (id: string) => void) => (
    <ModelPickerCommand
      models={pickerModels}
      selectedId={selectedId}
      onSelect={onSelect}
      emptyState={
        <div className="px-2 py-6 text-center text-[13px] text-muted-foreground">
          {emptyHint ?? t('settings.modelDefaults.noModels', 'No models available. Configure a provider first.')}
        </div>
      }
    />
  )

  const trigger = (label: string | null, unsetLabel: string) => (
    <button
      type="button"
      className={cn(
        'flex h-8 w-fit max-w-[min(100%,20rem)] items-center gap-1.5 rounded-md border border-border/70 px-2 font-mono text-xs',
        'hover:bg-muted/60 focus:outline-none data-[state=open]:bg-muted/60',
        !label && 'italic font-sans text-muted-foreground',
      )}
    >
      <span className="truncate">{label || unsetLabel}</span>
      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
    </button>
  )

  /** One entry point: what it runs on, and when that value takes effect. */
  const row = (
    title: string,
    effect: string,
    control: React.ReactNode,
    extra?: React.ReactNode,
  ) => (
    <SettingCard className="mb-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{effect}</p>
          {extra}
        </div>
        <div className="flex shrink-0 items-center gap-2">{control}</div>
      </div>
    </SettingCard>
  )

  return (
    <div className="mb-8">
      <SectionHeader
        icon={Box}
        title={t('settings.modelDefaults.title', 'Model defaults')}
        description={t(
          'settings.modelDefaults.description',
          'Where the gateway, scheduled jobs and chat each get their model from.',
        )}
      />

      {/*
        One card per entry point, not a "settings" card plus a "status" card.
        The first cut split them that way and it read as one global default plus
        a status list — but the editable gateway value, the cron pre-fill and the
        read-only chat value are three different mechanisms, and the cron pre-fill
        and its job count ended up in two different cards describing one thing.
        Grouping by entry point puts each control next to the sentence that says
        when it takes effect, which is the only question this screen answers.
      */}

      {/* Gateway — the one real run-time default here. */}
      {row(
        t('settings.modelDefaults.gateway', 'Gateway'),
        t(
          'settings.modelDefaults.gatewayEffect',
          'Takes effect immediately: every channel opens its next session on this. A single chat can still switch with /model.',
        ),
        <>
          {savingGateway && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <Popover open={gatewayOpen} onOpenChange={setGatewayOpen}>
            <PopoverTrigger asChild>
              {trigger(gatewayModel, t('settings.modelDefaults.gatewayUnset', 'Let the backend choose'))}
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={6} className="w-[20rem] p-0">
              {picker(gatewayModel ?? '', (id) => void applyGateway(id))}
            </PopoverContent>
          </Popover>
        </>,
      )}

      {/* Cron — a pre-fill, with the jobs it does NOT touch stated right below. */}
      {row(
        t('settings.modelDefaults.cron', 'Scheduled jobs'),
        t(
          'settings.modelDefaults.cronEffect',
          'Only pre-fills the form for a new job. Each job pins its own model when created, so changing this never moves an existing job.',
        ),
        <>
          <Popover open={defaultOpen} onOpenChange={setDefaultOpen}>
            <PopoverTrigger asChild>
              {trigger(newJobDefault, t('settings.modelDefaults.cronUnset', 'Not set'))}
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={6} className="w-[20rem] p-0">
              {picker(newJobDefault, (id) => {
                setDefaultOpen(false)
                if (backend && teamId) setDefault(backend, teamId, id)
              })}
            </PopoverContent>
          </Popover>
          {newJobDefault && (
            <button
              type="button"
              className="text-[12.5px] text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => backend && teamId && setDefault(backend, teamId, '')}
            >
              {t('settings.modelDefaults.clear', 'Clear')}
            </button>
          )}
        </>,
        <div className="mt-2 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <span>
            {cronJobs.length === 0
              ? t('settings.modelDefaults.cronNone', 'No jobs yet')
              : t('settings.modelDefaults.cronCount', {
                  // Not `count`: i18next reads that as a plural selector and goes
                  // looking for `_one` / `_other` variants we do not define.
                  jobs: cronJobs.length,
                  distinct: cronModels.size,
                  defaultValue: '{{jobs}} existing jobs · {{distinct}} model(s)',
                })}
          </span>
          {cronJobs.length > 0 && (
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => openSettings('automation')}
            >
              {t('settings.modelDefaults.view', 'View')}
            </button>
          )}
        </div>,
      )}

      {/* Chat — displayed only; `client-model-mru` owns it. See the header. */}
      {row(
        t('settings.modelDefaults.chat', 'Chat'),
        chatNext
          ? t(
              'settings.modelDefaults.chatEffect',
              'Follows the model you last picked in chat. Shown here, changed there.',
            )
          : t(
              'settings.modelDefaults.chatNone',
              'Nothing picked yet — the first send will ask you to choose.',
            ),
        <span className="font-mono text-xs text-muted-foreground">{chatNext || '—'}</span>,
      )}
    </div>
  )
}
