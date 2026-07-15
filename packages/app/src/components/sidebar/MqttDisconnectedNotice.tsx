import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/auth-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useUIStore } from '@/stores/ui'
import { useMqttConnected } from '@/hooks/useMqttConnected'
import { recoverMqttConnection } from '@/stores/mqtt-reconnect'

/**
 * Fallback MQTT disconnect notice for users without a LocalDaemon card, or when
 * the card does not surface `mqttDisconnected` (e.g. daemon HTTP offline).
 * Hidden while LocalDaemonCard shows its inline strip.
 */
export function MqttDisconnectedNotice() {
  const { t } = useTranslation()
  const userId = useAuthStore((s) => s.session?.user.id ?? null)
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const openSettings = useUIStore((s) => s.openSettings)
  const suppressed = useUIStore((s) => s.localDaemonMqttNoticeSuppressed)
  const connected = useMqttConnected()

  const expected = !!userId && !!currentTeamId
  if (!expected || connected !== false || suppressed) return null

  return (
    <button
      type="button"
      onClick={() => {
        void recoverMqttConnection()
        openSettings('general')
      }}
      className="flex w-full items-start gap-2 rounded-lg border border-[color:var(--coral-soft)] bg-paper px-2.5 py-2 text-left shadow-sm transition-colors hover:bg-[color:var(--coral-soft)]/40"
    >
      <span
        aria-hidden
        className="mt-[5px] inline-block h-2 w-2 shrink-0 rounded-full bg-coral"
      />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[12px] font-semibold text-foreground">
          {t('sidebar.mqttDisconnected', 'MQTT disconnected')}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {t('sidebar.mqttDisconnectedHint', 'Tap to configure server')}
        </span>
      </span>
    </button>
  )
}
