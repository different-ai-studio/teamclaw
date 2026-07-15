import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle, Users, Lock, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDaemonOnboardingStore, type Visibility } from '@/stores/daemon-onboarding'

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
  const { status, busy, error, ownedAgents, refresh, loadOwnedAgents, createNewAgent, bindExistingAgent, forceReset } =
    useDaemonOnboardingStore()
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

  React.useEffect(() => {
    if (status === 'ready') onDone()
  }, [status, onDone])

  React.useEffect(() => {
    if (mode === 'bind') void loadOwnedAgents()
  }, [mode, loadOwnedAgents])

  // Auto-recovery in progress (onboarded but daemon was down / token stale).
  if (status === 'starting') {
    return (
      <Shell
        title={t('settings.daemonOnboarding.startingTitle', 'Starting daemon…')}
        subtitle={t(
          'settings.daemonOnboarding.startingSubtitle',
          "This machine's agent is bound; making sure the background service is running.",
        )}
      >
        <div className="flex items-center gap-2 py-2 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('settings.daemonOnboarding.starting', 'Starting, please wait…')}
        </div>
      </Shell>
    )
  }

  // Auto-recovery failed.
  if (status === 'error') {
    return (
      <Shell
        title={t('settings.daemonOnboarding.errorTitle', "Can't start the local daemon")}
        subtitle={t(
          'settings.daemonOnboarding.errorSubtitle',
          "This machine's agent is bound, but the background service failed to start.",
        )}
      >
        {error && <ErrorLine error={error} />}
        <Button
          className="mt-1 h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {busy ? (
            <Spinner label={t('settings.daemonOnboarding.retrying', 'Retrying…')} />
          ) : (
            t('settings.daemonOnboarding.retry', 'Retry')
          )}
        </Button>
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
