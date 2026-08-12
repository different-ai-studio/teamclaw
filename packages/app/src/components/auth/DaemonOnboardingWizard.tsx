import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'

/**
 * This machine's agent: name it the first time, then never think about it again.
 *
 * The agent is resolved by (team, device id) server-side, so there is no
 * visibility to choose, no create-vs-bind fork, and no "belongs to another team"
 * reset. One question survives — what to call a robot that does not exist yet —
 * and it is only asked when the lookup comes back empty. Everything else here is
 * progress and failure.
 *
 * Mounting it is what starts the work: `refresh()` looks the machine up and either
 * binds it or parks the naming prompt.
 */
export function DaemonOnboardingWizard({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const { status, busy, error, refresh, pendingName, nameDeviceAgent } = useDaemonOnboardingStore()
  const [name, setName] = React.useState('')

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  // Prefill with the hostname once the prompt appears, so "just press enter" is a
  // sane default and the field is never empty.
  React.useEffect(() => {
    if (pendingName) setName((current) => current || pendingName.suggested)
  }, [pendingName])

  React.useEffect(() => {
    if (status === 'ready' && !pendingName) onDone()
  }, [status, pendingName, onDone])

  // The only input left in onboarding: this machine has no agent in this team yet.
  if (pendingName) {
    const trimmed = name.trim()
    return (
      <Shell
        title={t('settings.daemonOnboarding.nameTitle', 'Name this machine’s agent')}
        subtitle={t(
          'settings.daemonOnboarding.nameSubtitle',
          'It runs here, on this machine, and only you can see it. You can rename it later in settings.',
        )}
      >
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && trimmed && !busy) void nameDeviceAgent(trimmed)
          }}
          placeholder={pendingName.suggested}
          disabled={busy}
          className="h-10 rounded-[10px] text-[13px]"
        />
        {error && <ErrorLine error={error} />}
        <Button
          className="h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
          disabled={busy || trimmed.length === 0}
          onClick={() => void nameDeviceAgent(trimmed)}
        >
          {busy ? (
            <Spinner label={t('settings.daemonOnboarding.creating', 'Setting up…')} />
          ) : (
            t('settings.daemonOnboarding.nameConfirm', 'Continue')
          )}
        </Button>
      </Shell>
    )
  }

  // Binding in flight, or bound already and the daemon is being started.
  if (status === 'starting') {
    return (
      <Shell
        title={t('settings.daemonOnboarding.startingTitle', "Setting up this machine's agent…")}
        subtitle={t(
          'settings.daemonOnboarding.startingSubtitle',
          'Connecting this machine to the current team and starting the local daemon.',
        )}
      >
        <div className="flex items-center gap-2 py-2 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('settings.daemonOnboarding.starting', 'Starting, please wait…')}
        </div>
      </Shell>
    )
  }

  // Binding or auto-recovery failed. The copy stays vague about the cause on
  // purpose — `error` carries it, and it is not always the daemon (see
  // bindErrorMessage in the store).
  if (status === 'error') {
    return (
      <Shell
        title={t('settings.daemonOnboarding.errorTitle', "Can't set up this machine's agent")}
        subtitle={t(
          'settings.daemonOnboarding.errorSubtitle',
          'Nothing was left half-configured — retrying is safe.',
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

  // Everything else is a moment in transit: 'unknown' before the current team
  // resolves, 'needs-onboard'/'mismatch' in the beat before refresh() promotes
  // them to 'starting', and 'ready' between the status change and onDone.
  return (
    <Shell>
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
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
