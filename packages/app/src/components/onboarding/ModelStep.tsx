import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle, ChevronRight, Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ONBOARDING_PROVIDERS } from '@/lib/mainstream-providers'
import { useProviderStore } from '@/stores/provider'

/**
 * Third screen of first-run setup (#881), shown only on the guided path when
 * the runtime is pi — pi has no credentials of its own, so without a provider
 * the user lands in an app that cannot answer them.
 *
 * This works before sign-in because #742 made provider credentials
 * device-level: `connectProvider` no longer needs a workspace.
 *
 * Skipping is always allowed. A first run should never be a wall.
 */
export function ModelStep({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const connectProvider = useProviderStore((s) => s.connectProvider)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [apiKey, setApiKey] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  const submit = async () => {
    if (!selected || !apiKey.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const ok = await connectProvider(selected, apiKey.trim())
      if (!ok) {
        setError(t('onboarding.model.failed', 'Could not save that key. Check it and try again.'))
        return
      }
      setSaved(true)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background px-6 py-8" data-tauri-drag-region>
      <div className="absolute inset-x-0 top-0 h-12" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[520px] flex-1 flex-col justify-center gap-5">
        <div>
          <h1 className="text-[18px] font-semibold text-foreground">
            {t('onboarding.model.title', 'Connect a model')}
          </h1>
          <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
            {t(
              'onboarding.model.subtitle',
              'Pick a provider and paste its API key. You can add more later in Settings.',
            )}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          {ONBOARDING_PROVIDERS.map((p) => {
            const active = p.id === selected
            return (
              <div key={p.id} className="flex flex-col">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSelected(active ? null : p.id)
                    setError(null)
                  }}
                  className={cn(
                    'flex items-center justify-between rounded-[12px] border px-4 py-3 text-left transition-colors disabled:opacity-50',
                    active ? 'border-coral bg-selected/35' : 'border-border bg-paper hover:bg-selected/45',
                  )}
                >
                  <span className="text-[13px] font-medium text-foreground">{p.name}</span>
                  {active ? (
                    <Check className="h-4 w-4 text-coral" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-faint" />
                  )}
                </button>

                {active && (
                  <div className="mt-2 flex flex-col gap-2 px-1">
                    <Input
                      autoFocus
                      type="password"
                      value={apiKey}
                      disabled={busy}
                      placeholder={t('onboarding.model.keyPlaceholder', 'Paste the API key')}
                      onChange={(e) => {
                        setApiKey(e.target.value)
                        setError(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submit()
                      }}
                      className="h-10 rounded-[10px] font-mono text-[12px]"
                    />
                    <Button
                      className="h-10 rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
                      disabled={busy || !apiKey.trim()}
                      onClick={() => void submit()}
                    >
                      {busy ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {t('onboarding.model.saving', 'Saving…')}
                        </span>
                      ) : saved ? (
                        t('onboarding.model.saved', 'Saved')
                      ) : (
                        t('onboarding.model.connect', 'Connect')
                      )}
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {error && (
          <p className="flex items-start gap-1.5 text-[11.5px] text-coral">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={onDone}
          className="mx-auto rounded-[6px] text-[12px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
        >
          {t('onboarding.model.skip', 'Skip for now')}
        </button>
      </div>
    </div>
  )
}
