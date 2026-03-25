import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Shield } from 'lucide-react'
import { useTelemetryStore } from '@/stores/telemetry'
import { cn } from '@/lib/utils'
import { buildConfig } from '@/lib/build-config'

export function PrivacySection() {
  const { t } = useTranslation()
  const consent = useTelemetryStore((s) => s.consent)
  const setConsent = useTelemetryStore((s) => s.setConsent)

  const isGranted = consent === 'granted'

  const handleToggleConsent = React.useCallback(async () => {
    await setConsent(isGranted ? 'denied' : 'granted')
  }, [isGranted, setConsent])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Shield className="h-5 w-5 text-slate-500" />
          {t('settings.privacy.title', 'Privacy & Telemetry')}
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          {t('settings.privacy.description', { defaultValue: 'Control anonymous usage data collection to help improve {{appName}}.', appName: buildConfig.app.name })}
        </p>
      </div>

      {/* Consent Toggle */}
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">{t('settings.privacy.analyticsTitle', 'Analytics Data Collection')}</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              {t('settings.privacy.analyticsDesc', 'Store anonymous usage metrics locally (tokens, tool stats, scores). No code, conversations, or personal data. Data stays on your device.')}
            </p>
          </div>
          <button
            onClick={handleToggleConsent}
            className={cn(
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              isGranted ? 'bg-primary' : 'bg-input',
            )}
            role="switch"
            aria-checked={isGranted}
          >
            <span
              className={cn(
                'pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform',
                isGranted ? 'translate-x-5' : 'translate-x-0.5',
              )}
            />
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <div className={cn(
            'h-2 w-2 rounded-full',
            isGranted ? 'bg-green-500' : 'bg-muted-foreground/30',
          )} />
          {isGranted ? t('settings.privacy.analyticsEnabled', 'Analytics enabled') : t('settings.privacy.analyticsDisabled', 'Analytics disabled')}
        </div>
      </div>

    </div>
  )
}
