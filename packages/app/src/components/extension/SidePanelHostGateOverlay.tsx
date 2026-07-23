import { useTranslation } from 'react-i18next'
import { useSidePanelHostGate } from '@/hooks/use-side-panel-host-gate'

/**
 * Full-panel overlay when the active tab is outside the build-time domains allowlist.
 * Does not close the side panel (reopen would need a user gesture).
 */
export function SidePanelHostGateOverlay() {
  const { t } = useTranslation()
  const { blocked } = useSidePanelHostGate()

  if (!blocked) return null

  return (
    <div
      className="fixed inset-0 z-[10000] flex flex-col items-center justify-center gap-2 bg-background px-6 text-center"
      role="status"
      aria-live="polite"
      data-testid="side-panel-host-gate-overlay"
    >
      <p className="text-[15px] font-semibold text-foreground">
        {t('settings.extension.hostGate.title', 'Unavailable on this page')}
      </p>
    </div>
  )
}
