import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Box, ChevronDown, Loader2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ModelPickerCommand } from '@/components/model/ModelPickerCommand'
import { SettingCard } from './shared'
import { cn } from '@/lib/utils'
import { loadGatewayModel, saveGatewayModel } from '@/lib/amuxd-channels'
import { loadCronDialogModels, type CronModelGroup } from '@/lib/cron-workspace-models'
import { useCurrentTeamStore } from '@/stores/current-team'

/**
 * The model every gateway session starts on when the chat has not set its own
 * with `/model`.
 *
 * # Why this is one setting and not seven
 *
 * The seven platforms differ in how a message arrives, not in what should
 * answer it. Seven fields would be seven places to keep in sync for one
 * decision, and nothing in the product distinguishes "the model that answers
 * WeCom" from "the model that answers Feishu".
 *
 * # Why it exists at all
 *
 * A gateway session used to spawn **unpinned**: the backend picked, and
 * attach-time resolution fell back to the device MRU, so the same chat could
 * answer on a different model depending on which directory the daemon happened
 * to start in. ADR-0007 deletes that MRU, so the choice has to be stated —
 * this is where it is stated.
 *
 * Leaving it unset keeps the old unpinned behaviour rather than blocking the
 * gateway, so an existing install does not break on upgrade.
 */
export function GatewayModelCard() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)

  const [model, setModel] = React.useState<string | null>(null)
  const [groups, setGroups] = React.useState<CronModelGroup[]>([])
  const [hint, setHint] = React.useState<string | null>(null)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const current = await loadGatewayModel()
        if (!cancelled) setModel(current)
      } catch {
        // Daemon down — the picker still renders, it just cannot say what is set.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // The gateway runs in the daemon's default workspace, which is what the
  // 'global' cron scope already resolves — reuse it rather than re-deriving.
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const { groups: loaded, hint: loadedHint } = await loadCronDialogModels({
        activeScope: 'global',
        teamId,
        selectedWorkspacePath: null,
        messages: {
          workspaceNoPath: '',
          globalNoTeam: t('settings.channels.modelsNoTeam', 'Join a team to load models.'),
          globalNoDefault: t(
            'settings.channels.modelsNoDefault',
            'Set a default workspace in Daemon settings.',
          ),
          globalNoDefaultPath: t(
            'settings.channels.modelsNoDefaultPath',
            'Default workspace has no local path on this daemon.',
          ),
          daemonUnavailable: t(
            'settings.channels.modelsDaemonUnavailable',
            'Daemon is not ready. Wait for the app to finish starting, then try again.',
          ),
          noConfiguredModels: t(
            'settings.channels.modelsNoConfigured',
            'No configured models. Add a provider in LLM settings.',
          ),
          loadFailed: t('settings.channels.modelsLoadFailed', 'Failed to load models.'),
        },
      })
      if (cancelled) return
      setGroups(loaded)
      setHint(loadedHint)
    })().catch(() => {
      if (!cancelled) setHint(t('settings.channels.modelsLoadFailed', 'Failed to load models.'))
    })
    return () => {
      cancelled = true
    }
  }, [teamId, t])

  const pickerModels = React.useMemo(
    () =>
      groups.flatMap((group) =>
        group.models.map((m) => ({
          id: m.ref,
          displayName: m.name,
          providerName: m.providerName,
        })),
      ),
    [groups],
  )

  const apply = async (next: string) => {
    setMenuOpen(false)
    setSaving(true)
    // Optimistic: the daemon write is one-way (no reply on the sock), so there
    // is no ack to wait for. A failed save surfaces on the next mount.
    setModel(next || null)
    try {
      await saveGatewayModel(next)
    } catch (error) {
      console.error('[GatewayModel] save failed', error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingCard>
      <div className="flex items-start gap-3">
        <Box className="mt-0.5 h-5 w-5 shrink-0 text-indigo-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {t('settings.channels.gatewayModel', 'Gateway model')}
          </p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {t(
              'settings.channels.gatewayModelDescription',
              'Every channel starts its sessions on this model. A chat can still switch with /model.',
            )}
          </p>

          <div className="mt-2 flex items-center gap-2">
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'flex h-8 w-fit max-w-[min(100%,20rem)] items-center gap-1.5 rounded-md border border-border/70 px-2 font-mono text-xs',
                    'hover:bg-muted/60 focus:outline-none data-[state=open]:bg-muted/60',
                    !model && 'italic font-sans text-muted-foreground',
                  )}
                >
                  <span className="truncate">
                    {model ||
                      t('settings.channels.gatewayModelUnset', 'Let the backend choose')}
                  </span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} className="w-[20rem] p-0">
                <ModelPickerCommand
                  models={pickerModels}
                  selectedId={model ?? ''}
                  onSelect={(id) => void apply(id)}
                  emptyState={
                    <div className="px-2 py-6 text-center text-[13px] text-muted-foreground">
                      {hint ??
                        t('settings.channels.noModels', 'No models advertised.')}
                    </div>
                  }
                />
              </PopoverContent>
            </Popover>
            {saving && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
          </div>
        </div>
      </div>
    </SettingCard>
  )
}
