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

  return (
    <div className="mb-8">
      <SectionHeader
        icon={Box}
        title={t('settings.modelDefaults.title', 'Model defaults')}
        description={t(
          'settings.modelDefaults.description',
          'Which model the gateway, scheduled jobs and chat each run on, and which one new items start from.',
        )}
      />

      <SettingCard className="mb-4">
        <p className="font-medium">
          {t('settings.modelDefaults.newJobDefault', 'Default model (used when creating a job)')}
        </p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {t(
            'settings.modelDefaults.newJobDefaultHint',
            'Pre-fills the model for new scheduled jobs. Existing jobs keep the model pinned when they were created.',
          )}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Popover open={defaultOpen} onOpenChange={setDefaultOpen}>
            <PopoverTrigger asChild>
              {trigger(newJobDefault, t('settings.modelDefaults.unset', 'Not set'))}
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="w-[20rem] p-0">
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
        </div>
      </SettingCard>

      <SettingCard>
        <p className="font-medium">{t('settings.modelDefaults.inEffect', 'In effect now')}</p>

        <div className="mt-3 flex flex-col gap-3">
          {/* Gateway — a real run-time default, and the only editable one here. */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px]">{t('settings.modelDefaults.gateway', 'Gateway')}</p>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                {t(
                  'settings.modelDefaults.gatewayHint',
                  'Every channel starts its sessions on this. A chat can still switch with /model.',
                )}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {savingGateway && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              <Popover open={gatewayOpen} onOpenChange={setGatewayOpen}>
                <PopoverTrigger asChild>
                  {trigger(
                    gatewayModel,
                    t('settings.modelDefaults.gatewayUnset', 'Let the backend choose'),
                  )}
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={6} className="w-[20rem] p-0">
                  {picker(gatewayModel ?? '', (id) => void applyGateway(id))}
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Cron — read-only on purpose: the model lives on each job. */}
          <div className="flex items-start justify-between gap-3 border-t border-border-soft pt-3">
            <div className="min-w-0">
              <p className="text-[13px]">{t('settings.modelDefaults.cron', 'Scheduled jobs')}</p>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                {cronJobs.length === 0
                  ? t('settings.modelDefaults.cronNone', 'No jobs yet')
                  : t('settings.modelDefaults.cronPinned', {
                      // Not `count`: i18next reads that as a plural selector and
                      // goes looking for `_one` / `_other` variants we do not
                      // define. This is a plain interpolation.
                      jobs: cronJobs.length,
                      distinct: cronModels.size,
                      defaultValue: '{{jobs}} jobs · {{distinct}} model(s), pinned per job',
                    })}
              </p>
            </div>
            <button
              type="button"
              className="shrink-0 text-[12.5px] text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => openSettings('automation')}
            >
              {t('settings.modelDefaults.view', 'View')}
            </button>
          </div>

          {/* Chat — displayed, never written from here. See the header comment. */}
          <div className="flex items-start justify-between gap-3 border-t border-border-soft pt-3">
            <div className="min-w-0">
              <p className="text-[13px]">{t('settings.modelDefaults.chat', 'New chat session')}</p>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                {chatNext
                  ? t(
                      'settings.modelDefaults.chatHint',
                      "This client's most recent pick. Choosing a model in chat updates it.",
                    )
                  : t(
                      'settings.modelDefaults.chatNone',
                      'Nothing picked yet — the first send will ask you to choose.',
                    )}
              </p>
            </div>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{chatNext || '—'}</span>
          </div>
        </div>
      </SettingCard>
    </div>
  )
}
