import { useTranslation } from 'react-i18next'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Shown when post-login team bootstrap can't end up with a current team
 * (e.g. `createTeam` fails on a drifted backend). Without a team the app can't
 * continue — no daemon onboarding, sessions, or actors — so instead of
 * silently rendering an empty shell we surface the reason and offer a retry.
 */
export function TeamBootstrapErrorScreen({
  error,
  busy,
  onRetry,
  onSignOut,
}: {
  error: string | null
  busy: boolean
  onRetry: () => void
  onSignOut: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      className="flex h-screen items-center justify-center bg-background px-6"
      data-tauri-drag-region
    >
      <div className="w-full max-w-[440px] rounded-[16px] border border-border bg-paper p-6 shadow-sm">
        <h1 className="text-[16px] font-semibold text-foreground">
          {t('auth.teamBootstrapError.title', "Couldn't finish setting up your workspace")}
        </h1>
        <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
          {t(
            'auth.teamBootstrapError.subtitle',
            "You're signed in, but we couldn't create or load a team, so the app can't continue. This is usually a temporary server issue.",
          )}
        </p>
        <div className="mt-5 flex flex-col gap-4">
          {error ? (
            <p className="flex items-start gap-1.5 text-[11.5px] leading-4 text-coral">
              <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </p>
          ) : null}
          <Button
            className="mt-1 h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
            disabled={busy}
            onClick={onRetry}
          >
            {busy ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('auth.teamBootstrapError.retrying', 'Retrying…')}
              </span>
            ) : (
              t('auth.teamBootstrapError.retry', 'Retry')
            )}
          </Button>
          <button
            type="button"
            onClick={onSignOut}
            disabled={busy}
            className="text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {t('auth.teamBootstrapError.signOut', 'Sign out and use another account')}
          </button>
        </div>
      </div>
    </div>
  )
}
