import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, AlertCircle, Download, Terminal, Cpu } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useSetupStore, type RequirementStatus } from '@/stores/setup'
import { useOnboardingStore, type OnboardingRole } from '@/stores/onboarding'
import type { DaemonLocalAgent } from '@/lib/daemon-local-client'

/** amuxd auto-installs (a near-instant binary copy); pad it so it reads as work. */
const AMUXD_AUTO_INSTALL_MIN_MS = 2500

const RUNTIME_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  opencode: Terminal,
  pi: Cpu,
}

/** A runtime is usable if installed, even when a pinned upgrade is pending. */
function usable(r: RequirementStatus | undefined): boolean {
  return !!r && (r.present || r.version != null)
}

function RuntimeCard({
  runtime,
  selected,
  busy,
  onSelect,
  onInstall,
}: {
  runtime: RequirementStatus
  selected: boolean
  busy: boolean
  onSelect: () => void
  onInstall: () => void
}) {
  const { t } = useTranslation()
  const Icon = RUNTIME_ICON[runtime.id] ?? Terminal
  const installed = usable(runtime)
  // Select and Install are siblings, never nested. As a <span role="button">
  // inside the card's own <button>, Install was unreachable the entire time a
  // runtime was missing: an uninstalled card is disabled, and a disabled button
  // swallows pointer events for everything inside it — so the one control that
  // only ever appears on an uninstalled runtime could never be clicked.
  return (
    <div
      className={cn(
        'flex flex-1 flex-col items-start gap-2 rounded-[14px] border p-4 transition-colors',
        selected ? 'border-coral bg-selected/35' : 'border-border bg-paper',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={busy || !installed}
        className={cn(
          'flex w-full items-center justify-between text-left',
          installed && !busy ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        <span className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-ink-2" />
          <span className="text-[13px] font-semibold text-foreground">{runtime.title}</span>
        </span>
        {selected && <Check className="h-4 w-4 text-coral" />}
      </button>
      {installed ? (
        <span className="font-mono text-[11px] text-faint">
          {runtime.version ?? t('onboarding.setup.installed', 'installed')}
        </span>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={onInstall}
          className="inline-flex items-center gap-1.5 rounded-[6px] text-[11.5px] text-coral hover:underline disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          {t('onboarding.setup.install', 'Install')}
        </button>
      )}
    </div>
  )
}

function DependencyRow({ req, installing }: { req: RequirementStatus; installing: boolean }) {
  const { t } = useTranslation()
  const ok = usable(req)
  return (
    <div className="flex items-center justify-between rounded-[12px] border border-border bg-paper px-4 py-2.5">
      <span className="flex items-center gap-2">
        {ok ? (
          <Check className="h-4 w-4 text-coral" />
        ) : installing ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <AlertCircle className="h-4 w-4 text-faint" />
        )}
        <span className="text-[13px] text-foreground">{req.title}</span>
      </span>
      <span className="font-mono text-[11px] text-faint">
        {req.version ??
          (ok
            ? t('onboarding.setup.ready', 'ready')
            : installing
              ? t('onboarding.setup.installing', 'installing…')
              : t('onboarding.setup.missing', 'not found'))}
      </span>
    </div>
  )
}

/**
 * Second screen of first-run setup (#881). What it shows depends on the role
 * picked on the previous screen:
 *
 * - `developer` sees both runtimes with their install state and the optional
 *   git row (missing git is surfaced but never blocks).
 * - `guided` gets pi preselected and no dependency detail at all; if a runtime
 *   is already installed we offer to reuse it rather than download another.
 *
 * amuxd installs silently in both, since there is no meaningful choice to make
 * about it.
 */
export function SetupStep({ role, onDone }: { role: OnboardingRole; onDone: () => void }) {
  const { t } = useTranslation()
  const { requirements, agentRuntimes, installing, errors, loaded, listRequirements, listAgentRuntimes, install } =
    useSetupStore()
  const setRuntime = useOnboardingStore((s) => s.setRuntime)
  const [selected, setSelected] = React.useState<DaemonLocalAgent>('pi')

  React.useEffect(() => {
    void listAgentRuntimes()
  }, [listAgentRuntimes])

  React.useEffect(() => {
    void listRequirements(selected)
  }, [listRequirements, selected])

  // Guided users get whichever runtime is already on the machine — a working
  // install beats a fresh download. pi stays the default when neither is there.
  const autoPicked = React.useRef(false)
  React.useEffect(() => {
    if (role !== 'guided' || autoPicked.current || agentRuntimes.length === 0) return
    autoPicked.current = true
    const preinstalled = agentRuntimes.find((r) => usable(r))
    if (preinstalled) {
      const id = preinstalled.id as DaemonLocalAgent
      setSelected(id)
      // Mirror it into the store right away rather than waiting for Continue —
      // the next step branches on this value, and leaving it null until the
      // last moment is one more window for the two to disagree.
      setRuntime(id)
    }
  }, [role, agentRuntimes, setRuntime])

  const amuxd = requirements.find((r) => r.id === 'amuxd')
  const amuxdMissing = !!amuxd && !usable(amuxd)
  const amuxdTriggered = React.useRef(false)
  React.useEffect(() => {
    if (!loaded || !amuxdMissing || amuxdTriggered.current) return
    amuxdTriggered.current = true
    void install('amuxd', { minDurationMs: AMUXD_AUTO_INSTALL_MIN_MS })
  }, [loaded, amuxdMissing, install])

  const selectedRuntime = agentRuntimes.find((r) => r.id === selected)
  const runtimeReady = usable(selectedRuntime)
  const canContinue = loaded && !installing && !amuxdMissing && runtimeReady
  /**
   * Work is in flight and Continue is waiting on it.
   *
   * Wider than `installing` on purpose: the auto-install of amuxd is triggered
   * from an effect, so between "deps probed" and "install started" the button is
   * disabled with nothing running under it — and the guided screen offers no
   * other moving part, so the whole window reads as hung. Anything that greys
   * the button out while the machine is still working spins.
   */
  const busy = !!installing || amuxdMissing || (!runtimeReady && agentRuntimes.length > 0)

  const pick = (id: DaemonLocalAgent) => {
    setSelected(id)
    setRuntime(id)
  }

  const proceed = () => {
    setRuntime(selected)
    onDone()
  }

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background px-6 py-8" data-tauri-drag-region>
      <div className="absolute inset-x-0 top-0 h-12" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[520px] flex-1 flex-col justify-center gap-5">
        <div>
          <h1 className="text-[18px] font-semibold text-foreground">
            {t('onboarding.setup.title', 'Setting up your agent')}
          </h1>
          <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
            {role === 'developer'
              ? t('onboarding.setup.developerSubtitle', 'Pick the runtime this machine should use.')
              : t('onboarding.setup.guidedSubtitle', 'This only takes a moment.')}
          </p>
        </div>

        {role === 'developer' ? (
          <div className="flex flex-col gap-2">
            <span className="text-[11.5px] font-medium uppercase tracking-wide text-faint">
              {t('onboarding.setup.runtime', 'Agent runtime')}
            </span>
            <div className="flex gap-2.5">
              {agentRuntimes.map((r) => (
                <RuntimeCard
                  key={r.id}
                  runtime={r}
                  selected={r.id === selected}
                  busy={installing !== null}
                  onSelect={() => pick(r.id as DaemonLocalAgent)}
                  onInstall={() => void install(r.id)}
                />
              ))}
            </div>
            {agentRuntimes.map((r) =>
              errors[r.id] ? (
                <p key={`${r.id}-err`} className="flex items-start gap-1.5 text-[11.5px] text-coral">
                  <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{errors[r.id]}</span>
                </p>
              ) : null,
            )}
          </div>
        ) : (
          selectedRuntime && (
            <DependencyRow req={selectedRuntime} installing={installing === selectedRuntime.id} />
          )
        )}

        <div className="flex flex-col gap-2">
          {amuxd && <DependencyRow req={amuxd} installing={installing === 'amuxd'} />}
          {/* git is `optional: true` from the backend; only developers need to
              know it is missing, and even for them it never blocks. */}
          {role === 'developer' &&
            requirements
              .filter((r) => r.id === 'git')
              .map((r) => <DependencyRow key={r.id} req={r} installing={installing === r.id} />)}
        </div>

        {errors.amuxd && (
          <p className="flex items-start gap-1.5 text-[11.5px] text-coral">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{errors.amuxd}</span>
          </p>
        )}

        <Button
          className="h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
          disabled={!canContinue}
          onClick={proceed}
        >
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('onboarding.setup.working', 'Setting up…')}
            </span>
          ) : (
            t('onboarding.setup.continue', 'Continue')
          )}
        </Button>

        {/* Picking the simpler path should never be a one-way door. */}
        {role === 'guided' && (
          <button
            type="button"
            onClick={() => useOnboardingStore.getState().setRole('developer')}
            className="mx-auto rounded-[6px] text-[12px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            {t('onboarding.setup.switchToDeveloper', 'Let me choose the runtime instead')}
          </button>
        )}
      </div>
    </div>
  )
}
