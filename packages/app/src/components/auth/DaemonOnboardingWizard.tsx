import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle, Users, Lock, ChevronRight, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  useDaemonOnboardingStore,
  ONBOARDING_STEPS,
  type Visibility,
  type OnboardingStep,
} from '@/stores/daemon-onboarding'

/** Show elapsed time and a per-step hint once a run passes this. */
const SLOW_HINT_MS = 8_000
/** Surface the log path and an explicit retry once it passes this. */
const STUCK_HINT_MS = 25_000

/** Tick once a second while a run is in flight, for elapsed-time display. */
function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (startedAt == null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  return startedAt == null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
}

function StepList({
  current,
  completed,
  failed,
}: {
  current: OnboardingStep | null
  completed: OnboardingStep[]
  failed: OnboardingStep | null
}) {
  const { t } = useTranslation()
  const label = (step: OnboardingStep) =>
    t(`settings.daemonOnboarding.steps.${step}`, step)
  return (
    <ul className="flex flex-col gap-1.5">
      {ONBOARDING_STEPS.map((step) => {
        const isDone = completed.includes(step)
        const isFailed = step === failed
        const isActive = step === current
        return (
          <li key={step} className="flex items-center gap-2 text-[12.5px]">
            {isFailed ? (
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-coral" />
            ) : isDone ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-coral" />
            ) : isActive ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <span className="ml-[5px] mr-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-faint/50" />
            )}
            <span
              className={cn(
                isFailed
                  ? 'text-coral'
                  : isDone
                    ? 'text-muted-foreground'
                    : isActive
                      ? 'text-foreground'
                      : 'text-faint',
              )}
            >
              {label(step)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** Calm segmented control (no heavy solid-black buttons). */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div className="inline-flex rounded-[9px] bg-panel p-[3px]">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-[7px] px-3.5 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50',
              active
                ? 'bg-paper text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-medium uppercase tracking-wide text-faint">{label}</span>
      {children}
    </div>
  )
}

export function DaemonOnboardingWizard({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const {
    status,
    busy,
    error,
    ownedAgents,
    step,
    completedSteps,
    failedStep,
    runStartedAt,
    completedAgent,
    refresh,
    loadOwnedAgents,
    createNewAgent,
    bindExistingAgent,
    forceReset,
    autoHealCloudSession,
  } = useDaemonOnboardingStore()
  const elapsed = useElapsedSeconds(runStartedAt)
  const [mode, setMode] = React.useState<'new' | 'bind'>('new')
  const [name, setName] = React.useState('')
  const nameTouched = React.useRef(false)
  const [visibility, setVisibility] = React.useState<Visibility>('personal')

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  // Suggest this machine's hostname as the default agent name. The user can
  // still edit it; once they type, we stop overwriting their input.
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const host = (await invoke<string>('get_device_hostname'))?.trim()
        if (!cancelled && host && !nameTouched.current) setName(host)
      } catch {
        // Non-Tauri / command unavailable — keep the placeholder.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // On the silent auto-recovery path (nothing the user initiated) hand off
  // immediately, exactly as before — a cold start should gain no latency. When
  // the user actually created or bound an agent, hold briefly to confirm what
  // was set up instead of just vanishing.
  React.useEffect(() => {
    if (status !== 'ready') return
    if (!completedAgent) {
      onDone()
      return
    }
    const id = setTimeout(onDone, 1500)
    return () => clearTimeout(id)
  }, [status, onDone, completedAgent])

  React.useEffect(() => {
    if (mode === 'bind') void loadOwnedAgents()
  }, [mode, loadOwnedAgents])

  if (status === 'ready' && completedAgent) {
    return (
      <Shell title={t('settings.daemonOnboarding.doneTitle', 'This machine is ready')}>
        <p className="flex items-center gap-2 text-[13px] text-foreground">
          <Check className="h-4 w-4 shrink-0 text-coral" />
          {t('settings.daemonOnboarding.doneAs', 'Set up as {{name}}', {
            name: completedAgent.displayName,
          })}
        </p>
        <Button
          className="mt-1 h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
          onClick={onDone}
        >
          {t('settings.daemonOnboarding.continue', 'Continue')}
        </Button>
      </Shell>
    )
  }

  // Auto-recovery in progress (onboarded but daemon was down / token stale).
  if (status === 'starting') {
    return (
      <Shell
        title={t('settings.daemonOnboarding.startingTitle', 'Starting daemon…')}
        subtitle={t(
          'settings.daemonOnboarding.startingSubtitle',
          "This machine's agent is bound; making sure the local daemon is running.",
        )}
      >
        <StepList current={step} completed={completedSteps} failed={failedStep} />
        {elapsed * 1000 >= SLOW_HINT_MS && (
          <div className="flex flex-col gap-1 border-t border-border-soft pt-3">
            <span className="text-[11.5px] text-muted-foreground">
              {t('settings.daemonOnboarding.elapsed', 'Still working — {{seconds}}s', {
                seconds: elapsed,
              })}
            </span>
            {step && (
              <span className="text-[11.5px] leading-4 text-faint">
                {t(`settings.daemonOnboarding.slowHint.${step}`, '')}
              </span>
            )}
            {elapsed * 1000 >= STUCK_HINT_MS && (
              <>
                <span className="text-[11.5px] leading-4 text-faint">
                  {t(
                    'settings.daemonOnboarding.stuckHint',
                    'Taking longer than expected. Check ~/.amuxd/amuxd.managed.log for details.',
                  )}
                </span>
                <Button
                  variant="outline"
                  className="mt-1 h-9 rounded-[10px]"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  {t('settings.daemonOnboarding.retry', 'Retry')}
                </Button>
              </>
            )}
          </div>
        )}
      </Shell>
    )
  }

  // Auto-recovery failed. Name the step that broke and offer the recovery that
  // fits it, rather than one generic Retry for five different failures.
  if (status === 'error') {
    return (
      <Shell
        title={
          failedStep
            ? t('settings.daemonOnboarding.errorAtStep', 'Setup stopped at: {{step}}', {
                step: t(`settings.daemonOnboarding.steps.${failedStep}`, failedStep),
              })
            : t('settings.daemonOnboarding.errorTitle', "Can't start the local daemon")
        }
        subtitle={
          failedStep
            ? t(`settings.daemonOnboarding.recovery.${failedStep}`, '')
            : t(
                'settings.daemonOnboarding.errorSubtitle',
                "This machine's agent is bound, but the local daemon failed to start.",
              )
        }
      >
        {failedStep && (
          <StepList current={null} completed={completedSteps} failed={failedStep} />
        )}
        {error && <ErrorLine error={error} />}
        <Button
          className="mt-1 h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
          disabled={busy}
          onClick={() =>
            void (failedStep === 'cloud-auth' ? autoHealCloudSession() : refresh())
          }
        >
          {busy ? (
            <Spinner label={t('settings.daemonOnboarding.retrying', 'Retrying…')} />
          ) : failedStep === 'cloud-auth' ? (
            t('settings.daemonOnboarding.reconnect', 'Reconnect')
          ) : (
            t('settings.daemonOnboarding.retry', 'Retry')
          )}
        </Button>
        {/* Credentials may be half-written after these two, so a plain retry can
            keep failing the same way; a reset gives the user a way out. */}
        {(failedStep === 'init-daemon' || failedStep === 'restart-daemon') && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void forceReset()}
            className="mx-auto rounded-[6px] text-[12px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
          >
            {t('settings.daemonOnboarding.resetReinit', 'Reset and re-initialize')}
          </button>
        )}
      </Shell>
    )
  }

  // Other transitional states (unknown / ready-before-onDone).
  if (status !== 'needs-onboard' && status !== 'mismatch') {
    return (
      <Shell>
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </Shell>
    )
  }

  if (status === 'mismatch') {
    return (
      <Shell
        title={t('settings.daemonOnboarding.mismatchTitle', "This machine's agent belongs to another team")}
        subtitle={t(
          'settings.daemonOnboarding.mismatchSubtitle',
          "The signed-in team doesn't match the team this machine's daemon is bound to. It needs to be reset and re-initialized.",
        )}
      >
        {error && <ErrorLine error={error} />}
        <Button
          className="mt-1 h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
          disabled={busy}
          onClick={() => void forceReset()}
        >
          {busy ? (
            <Spinner label={t('settings.daemonOnboarding.resetting', 'Resetting…')} />
          ) : (
            t('settings.daemonOnboarding.resetReinit', 'Reset and re-initialize')
          )}
        </Button>
      </Shell>
    )
  }

  return (
    <Shell
      title={t('settings.daemonOnboarding.initTitle', "Set up this machine's agent")}
      subtitle={t(
        'settings.daemonOnboarding.initSubtitle',
        'Create a new agent, or bind this machine to one you already have.',
      )}
    >
      <Segmented
        value={mode}
        disabled={busy}
        onChange={(m) => setMode(m)}
        options={[
          { value: 'new', label: t('settings.daemonOnboarding.modeNew', 'New') },
          { value: 'bind', label: t('settings.daemonOnboarding.modeBind', 'Bind existing') },
        ]}
      />

      {mode === 'new' ? (
        <div className="flex flex-col gap-4">
          <Field label={t('settings.daemonOnboarding.name', 'Name')}>
            <Input
              placeholder={t('settings.daemonOnboarding.namePlaceholder', 'e.g. MacBook Pro')}
              value={name}
              onChange={(e) => {
                nameTouched.current = true
                setName(e.target.value)
              }}
              disabled={busy}
              className="h-10 rounded-[10px] text-[13px]"
            />
          </Field>

          <Field label={t('settings.daemonOnboarding.visibility', 'Visibility')}>
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={visibility === 'team'}
                disabled={busy}
                onChange={(e) => setVisibility(e.target.checked ? 'team' : 'personal')}
                className="mt-0.5 h-4 w-4 shrink-0 rounded-[5px] border-border accent-coral disabled:opacity-50"
              />
              <span className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-foreground">
                  {t('settings.daemonOnboarding.shareWithTeam', 'Share with the team')}
                </span>
                <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  {visibility === 'team' ? (
                    <>
                      <Users className="h-3 w-3 shrink-0" />{' '}
                      {t('settings.daemonOnboarding.visibilityTeamHint', 'Everyone on the team can see and use this agent.')}
                    </>
                  ) : (
                    <>
                      <Lock className="h-3 w-3 shrink-0" />{' '}
                      {t(
                        'settings.daemonOnboarding.visibilityPersonalHint',
                        'Only you can see and use it; hidden from the rest of the team.',
                      )}
                    </>
                  )}
                </span>
              </span>
            </label>
          </Field>

          {error && <ErrorLine error={error} />}

          <Button
            className="h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
            disabled={busy || name.trim().length === 0}
            onClick={() => void createNewAgent(name.trim(), visibility)}
          >
            {busy ? (
              <Spinner label={t('settings.daemonOnboarding.creating', 'Setting up…')} />
            ) : (
              t('settings.daemonOnboarding.create', 'Create and start')
            )}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {ownedAgents.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-faint">
              {t('settings.daemonOnboarding.noOwnedAgents', 'You have no agents in the current team to bind to.')}
            </p>
          ) : (
            ownedAgents.map((a) => (
              <button
                key={a.agentId}
                type="button"
                disabled={busy}
                onClick={() => void bindExistingAgent(a.agentId, a.displayName)}
                className="group flex items-center justify-between rounded-[12px] border border-border bg-paper px-4 py-3 text-left transition-colors hover:bg-selected disabled:opacity-50"
              >
                <span className="flex flex-col">
                  <span className="text-[13px] font-medium text-foreground">{a.displayName || a.agentId}</span>
                  <span className="font-mono text-[11px] text-faint">{a.visibility}</span>
                </span>
                <ChevronRight className="h-4 w-4 text-faint transition-colors group-hover:text-muted-foreground" />
              </button>
            ))
          )}
          {error && <ErrorLine error={error} />}
        </div>
      )}
    </Shell>
  )
}

function Shell({
  title,
  subtitle,
  children,
}: {
  title?: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex h-screen items-center justify-center bg-background px-6" data-tauri-drag-region>
      <div className="w-full max-w-[440px] rounded-[16px] border border-border bg-paper p-6 shadow-sm">
        {title && <h1 className="text-[16px] font-semibold text-foreground">{title}</h1>}
        {subtitle && <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">{subtitle}</p>}
        <div className="mt-5 flex flex-col gap-4">{children}</div>
      </div>
    </div>
  )
}

function Spinner({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </span>
  )
}

function ErrorLine({ error }: { error: string }) {
  return (
    <p className="flex items-start gap-1.5 text-[11.5px] leading-4 text-coral">
      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 break-words">{error}</span>
    </p>
  )
}
