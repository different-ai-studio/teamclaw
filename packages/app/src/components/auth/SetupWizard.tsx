import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, Download, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSetupStore, type RequirementStatus } from '@/stores/setup'

/** amuxd auto-installs (a near-instant binary copy); pad the loading state so the
 *  install reads as real work rather than a flicker. */
const AMUXD_AUTO_INSTALL_MIN_MS = 2500

function StatusIcon({ req, installing }: { req: RequirementStatus; installing: boolean }) {
  if (req.present) return <Check className="h-4 w-4 text-coral" />
  if (installing) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  return <Download className="h-4 w-4 text-faint" />
}

export function SetupWizard({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const { requirements, installing, output, errors, loaded, listRequirements, install, requiredSatisfied } =
    useSetupStore()

  // AuthGate already triggers the load before mounting us; guard avoids a
  // redundant IPC round-trip while keeping this component self-contained.
  React.useEffect(() => {
    if (!loaded) void listRequirements()
  }, [loaded, listRequirements])

  // amuxd has no manual install button — it auto-installs once requirements
  // are known and it's missing. The ref guards against re-triggering on the
  // re-renders that the install itself causes.
  const amuxd = requirements.find((r) => r.id === 'amuxd')
  const amuxdMissing = !!amuxd && !amuxd.present
  const amuxdTriggered = React.useRef(false)
  React.useEffect(() => {
    if (!loaded || !amuxdMissing || amuxdTriggered.current) return
    amuxdTriggered.current = true
    void install('amuxd', { minDurationMs: AMUXD_AUTO_INSTALL_MIN_MS })
  }, [loaded, amuxdMissing, install])

  const retryAmuxd = React.useCallback(() => {
    void install('amuxd', { minDurationMs: AMUXD_AUTO_INSTALL_MIN_MS })
  }, [install])

  const allReady = requiredSatisfied()

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-background" data-tauri-drag-region>
      <div className="h-10 shrink-0" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center gap-4 px-6 pb-12">
        <div>
          <h1 className="text-[15px] font-bold text-foreground">{t('setupWizard.title')}</h1>
          <p className="mt-1 text-[12.5px] text-muted-foreground">{t('setupWizard.intro')}</p>
        </div>

        <div className="flex flex-col gap-2">
          {requirements.map((req) => {
            const isAmuxd = req.id === 'amuxd'
            const isInstalling = installing === req.id
            // present-but-not-ready with a detected version => upgrade; no version => fresh install.
            const isUpgrade = !req.present && !!req.version
            const lines = output[req.id] ?? []
            const err = errors[req.id]
            // amuxd shows a busy state (not a button) the whole time it's missing
            // and not in an error state, since it auto-installs.
            const amuxdBusy = isAmuxd && !req.present && !err
            // Backend titles are English identifiers; localize by id, fall back to the title.
            const title = t(`setupWizard.deps.${req.id}`, { defaultValue: req.title })
            return (
              <div key={req.id} className="rounded-[16px] border border-border bg-paper p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <StatusIcon req={req} installing={isInstalling || amuxdBusy} />
                    <span className="text-[13px] font-semibold text-foreground">{title}</span>
                    {req.optional && (
                      <span className="rounded-[4px] bg-panel px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {t('setupWizard.optional')}
                      </span>
                    )}
                  </div>
                  {req.present ? (
                    <span className="font-mono text-[11px] text-faint">{t('setupWizard.ready')}</span>
                  ) : isAmuxd ? (
                    err ? (
                      <Button size="sm" disabled={installing !== null} onClick={retryAmuxd}>
                        {t('setupWizard.retry')}
                      </Button>
                    ) : (
                      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {t('setupWizard.autoInstalling')}
                      </span>
                    )
                  ) : (
                    <Button size="sm" disabled={installing !== null} onClick={() => void install(req.id)}>
                      {isInstalling
                        ? isUpgrade
                          ? t('setupWizard.upgrading')
                          : t('setupWizard.installing')
                        : isUpgrade
                          ? t('setupWizard.upgrade')
                          : t('setupWizard.install')}
                    </Button>
                  )}
                </div>
                {req.version && (
                  <p className="mt-1 font-mono text-[11px] text-faint">
                    {isUpgrade ? t('setupWizard.currentNeedsUpgrade', { version: req.version }) : req.version}
                  </p>
                )}
                {(isInstalling || amuxdBusy) && lines.length > 0 && (
                  <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
                    {lines[lines.length - 1]}
                  </p>
                )}
                {err && (
                  <p className="mt-2 flex items-center gap-1 text-[11.5px] text-coral">
                    <AlertCircle className="h-3 w-3" /> {err}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <Button
          className="mt-2 h-10 bg-coral text-coral-foreground hover:opacity-90"
          disabled={!allReady || installing !== null}
          onClick={onDone}
        >
          {allReady ? t('setupWizard.continue') : t('setupWizard.installRequiredFirst')}
        </Button>
      </div>
    </div>
  )
}
