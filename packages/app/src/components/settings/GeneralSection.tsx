import * as React from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { invoke } from '@tauri-apps/api/core'
import {
  Settings2,
  Moon,
  Sun,
  Monitor,
  Languages,
  Bell,
  Server,
  User,
  Bug,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useMqttConnected } from '@/hooks/useMqttConnected'
import { useMqttReconnectStore, recoverMqttConnection } from '@/stores/mqtt-reconnect'
import { useCurrentTeamStore } from '@/stores/current-team'
import { getBackend } from '@/lib/backend'
import { SettingCard, SectionHeader, ToggleSwitch } from './shared'
import { useAcpDebugStore } from '@/stores/acp-debug-store'
import { appShortName, buildConfig } from '@/lib/build-config'
import { LANGUAGE_OPTIONS, getPreferredLanguage, normalizeSupportedLanguage, persistLanguage } from '@/lib/locale'
import { getEffectiveServerConfig, type ServerConfig } from '@/lib/server-config'

// Theme helpers
const THEME_STORAGE_KEY = `${buildConfig.app.shortName ?? 'teamclaw'}-theme`
const DEFAULT_THEME = buildConfig.defaults?.theme || 'system'

function applyTheme(theme: string) {
  const root = document.documentElement
  if (theme === 'dark') {
    root.classList.add('dark')
  } else if (theme === 'light') {
    root.classList.remove('dark')
  } else {
    // system
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    if (prefersDark) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }
}

function getStoredTheme(): string {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

// Apply theme immediately on module load to prevent flash
applyTheme(getStoredTheme())

export const GeneralSection = React.memo(function GeneralSection() {
  const { t } = useTranslation()
  const [theme, setThemeState] = React.useState(getStoredTheme)
  const [language, setLanguage] = React.useState(() => {
    return getPreferredLanguage()
  })

  // Sync language state with i18n instance
  React.useEffect(() => {
    const handleLanguageChange = () => {
      setLanguage(i18next.language);
    };

    i18next.on('languageChanged', handleLanguageChange);
    return () => {
      i18next.off('languageChanged', handleLanguageChange);
    };
  }, []);
  // Account: the current user's own display name (editable).
  const currentMemberName = useCurrentTeamStore((s) => s.currentMember?.displayName ?? '')
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? '')
  const currentTeamName = useCurrentTeamStore((s) => s.team?.name ?? '')
  // Org name/id aren't kept in the current-team cache; resolve them from the
  // membership list (which carries orgId/orgName) by matching the active team.
  const [orgInfo, setOrgInfo] = React.useState<{ orgId: string | null; orgName: string | null }>({
    orgId: null,
    orgName: null,
  })
  React.useEffect(() => {
    if (!currentTeamId) return
    let cancelled = false
    void (async () => {
      try {
        const teams = await getBackend().teams.listAllMyTeams()
        if (cancelled) return
        const match = teams.find((tm) => tm.id === currentTeamId)
        setOrgInfo({ orgId: match?.orgId ?? null, orgName: match?.orgName ?? null })
      } catch {
        // Best-effort: org metadata is informational only.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentTeamId])
  const renameCurrentMember = useCurrentTeamStore((s) => s.renameCurrentMember)
  const memberSaving = useCurrentTeamStore((s) => s.saving)
  const [displayNameDraft, setDisplayNameDraft] = React.useState(currentMemberName)
  // Keep the draft in sync when the member loads / changes elsewhere, but don't
  // clobber an in-progress edit.
  const [displayNameDirty, setDisplayNameDirty] = React.useState(false)
  React.useEffect(() => {
    if (!displayNameDirty) setDisplayNameDraft(currentMemberName)
  }, [currentMemberName, displayNameDirty])

  const handleSaveDisplayName = React.useCallback(async () => {
    const trimmed = displayNameDraft.trim()
    if (!trimmed || trimmed === currentMemberName) return
    const ok = await renameCurrentMember(trimmed)
    if (ok) {
      setDisplayNameDirty(false)
      toast.success(t('settings.general.displayNameSaved', 'Display name updated'))
    } else {
      toast.error(t('settings.general.displayNameError', 'Could not update display name'))
    }
  }, [displayNameDraft, currentMemberName, renameCurrentMember, t])

  const [notificationLevel, setNotificationLevelState] = React.useState(() => {
    try {
      const stored = localStorage.getItem(`${appShortName}-notification-level`)
      if (stored === 'all' || stored === 'important' || stored === 'mute') return stored
    } catch { /* ignore */ }
    return 'important'
  })
  const setNotificationLevel = React.useCallback((level: string) => {
    setNotificationLevelState(level)
    try { localStorage.setItem(`${appShortName}-notification-level`, level) } catch { /* ignore */ }
  }, [])
  const acpStreamDebugEnabled = useAcpDebugStore((s) => s.enabled)
  const setAcpStreamDebugEnabled = useAcpDebugStore((s) => s.setEnabled)
  // Listen to system preference changes when theme is 'system'
  React.useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  const setTheme = React.useCallback((t: string) => {
    setThemeState(t)
    try { localStorage.setItem(THEME_STORAGE_KEY, t) } catch { /* ignore */ }
    applyTheme(t)
  }, [])

  const handleLanguageChange = React.useCallback((value: string) => {
    const normalizedValue = normalizeSupportedLanguage(value)
    setLanguage(normalizedValue)
    i18next.changeLanguage(normalizedValue)
    persistLanguage(normalizedValue)
    void invoke('set_config_locale', { locale: normalizedValue }).catch(() => {
      // Settings should still update locally if the native config is unavailable.
    })
  }, [])

  const themeIcons: Record<string, React.ElementType> = {
    light: Sun,
    dark: Moon,
    system: Monitor,
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Settings2}
        title={t('settings.general.title', 'General')}
        description={t('settings.general.description', 'Customize your application preferences')}
        iconColor="text-blue-500"
      />

      {currentMemberName ? (
        <SettingCard>
          <div className="space-y-2">
            <label className="text-[13px] font-medium flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              {t('settings.general.displayName', 'Display Name')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('settings.general.displayNameDesc', 'The name teammates see for you')}
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={displayNameDraft}
                onChange={(e) => {
                  setDisplayNameDraft(e.target.value)
                  setDisplayNameDirty(true)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSaveDisplayName()
                }}
                placeholder={t('settings.general.displayNamePlaceholder', 'Your name')}
                maxLength={60}
                className="h-11"
                data-testid="display-name-input"
              />
              <Button
                onClick={() => void handleSaveDisplayName()}
                disabled={
                  memberSaving ||
                  !displayNameDraft.trim() ||
                  displayNameDraft.trim() === currentMemberName
                }
                className="h-11 shrink-0"
              >
                {t('settings.general.save', 'Save')}
              </Button>
            </div>
          </div>
        </SettingCard>
      ) : null}

      {currentTeamId ? (
        <SettingCard>
          <div className="space-y-3">
            <label className="text-[13px] font-medium flex items-center gap-2">
              <Server className="h-4 w-4 text-muted-foreground" />
              {t('settings.general.teamInfo', 'Team & Organization')}
            </label>
            <dl className="space-y-2 text-xs">
              {[
                { label: t('settings.general.teamName', 'Team name'), value: currentTeamName },
                { label: t('settings.general.teamId', 'Team ID'), value: currentTeamId },
                { label: t('settings.general.orgName', 'Org name'), value: orgInfo.orgName ?? '—' },
                { label: t('settings.general.orgId', 'Org ID'), value: orgInfo.orgId ?? '—' },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground shrink-0">{row.label}</dt>
                  <dd className="font-mono text-right break-all select-text">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </SettingCard>
      ) : null}

      <SettingCard>
        <h4 className="font-medium mb-4 flex items-center gap-2">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          {t('settings.general.appearance', 'Appearance')}
        </h4>
        <div className="grid grid-cols-3 gap-3">
          {(['light', 'dark', 'system'] as const).map((t) => {
            const Icon = themeIcons[t]
            return (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-[14px] border p-4 transition-colors",
                  theme === t 
                    ? "border-border bg-selected text-foreground" 
                    : "border-border-soft bg-panel/60 text-muted-foreground hover:bg-selected/60 hover:text-foreground"
                )}
              >
                <Icon className={cn("h-5 w-5", theme === t ? "text-foreground" : "text-muted-foreground")} />
                <span className={cn("text-[13px] capitalize", theme === t ? "font-medium" : "text-muted-foreground")}>
                  {t}
                </span>
              </button>
            )
          })}
        </div>
      </SettingCard>

      {!import.meta.env.VITE_LOCALE || import.meta.env.VITE_LOCALE === 'all' ? (
        <SettingCard>
          <div className="space-y-2">
            <label className="text-[13px] font-medium flex items-center gap-2">
              <Languages className="h-4 w-4 text-muted-foreground" />
              {t('settings.general.language', 'Language')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('settings.general.languageDesc', 'Choose the app display language')}
            </p>
            <Select value={language} onValueChange={handleLanguageChange}>
              <SelectTrigger className="h-11" data-testid="language-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.value === 'en' ? '🇺🇸 ' : '🇨🇳 '}
                    {t(option.labelKey, option.fallback)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingCard>
      ) : null}

      <SettingCard>
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-[13px] font-medium flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
              {t('settings.general.notifications', 'Notifications')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('settings.general.notificationsDesc', 'Control when desktop notifications are sent')}
            </p>
            <Select value={notificationLevel} onValueChange={setNotificationLevel}>
              <SelectTrigger className="h-11" data-testid="notification-level-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('settings.general.notifAll', 'All notifications')}</SelectItem>
                <SelectItem value="important">{t('settings.general.notifImportant', 'Important only')}</SelectItem>
                <SelectItem value="mute">{t('settings.general.notifMute', 'Mute')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="border-t pt-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <label className="text-[13px] font-medium flex items-center gap-2">
                  <Bug className="h-4 w-4 text-muted-foreground" />
                  {t('settings.general.acpStreamDebug', 'ACP stream debug')}
                </label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.general.acpStreamDebugDesc', 'Show live ACP event stream above the chat thread')}
                </p>
              </div>
              <ToggleSwitch
                enabled={acpStreamDebugEnabled}
                onChange={setAcpStreamDebugEnabled}
              />
            </div>
          </div>
        </div>
      </SettingCard>

      <ServerAddressCard />
    </div>
  )
})

function ServerAddressCard() {
  const { t } = useTranslation()
  const [effective, setEffective] = React.useState<ServerConfig>({})

  const reload = React.useCallback(async () => {
    setEffective(await getEffectiveServerConfig())
  }, [])

  React.useEffect(() => {
    void reload()
  }, [reload])

  const mqttConnected = useMqttConnected()
  const mqttLastError = useMqttReconnectStore((s) => s.lastError)

  const mqttBroker = React.useMemo(() => {
    if (effective.mqttUrl) return effective.mqttUrl
    if (!effective.mqttHost) return null
    const scheme = effective.mqttUseTls ? 'mqtts' : 'mqtt'
    const port = effective.mqttPort ?? (effective.mqttUseTls ? 8883 : 1883)
    return `${scheme}://${effective.mqttHost}:${port}`
  }, [effective.mqttUrl, effective.mqttHost, effective.mqttPort, effective.mqttUseTls])

  return (
    <SettingCard>
      <h4 className="font-medium mb-4 flex items-center gap-2">
        <Server className="h-4 w-4 text-muted-foreground" />
        {t('settings.general.server', 'Server')}
      </h4>
      <div className="space-y-1.5">
        <label className="text-[12px] font-medium text-muted-foreground">
          {t('settings.general.serverAddress', 'Server address')}
        </label>
        <p className="font-mono text-[12.5px] text-foreground break-all">
          {effective.cloudApiUrl || '—'}
        </p>
      </div>

      <div className="mt-5 space-y-2 border-t border-border-soft pt-4">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-muted-foreground">
            {t('settings.general.serverSynced', 'Synced from server')}
          </span>
          <span className="text-[11px] text-faint">
            {t('settings.general.serverSyncedHint', 'Delivered on sign-in, read-only')}
          </span>
        </div>
        {mqttBroker ? (
          <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-[12px]">
            <dt className="text-muted-foreground">{t('settings.general.mqttBroker', 'MQTT broker')}</dt>
            <dd className="font-mono text-foreground break-all">{mqttBroker}</dd>
            <dt className="text-muted-foreground">{t('settings.general.mqttStatus', 'Status')}</dt>
            <dd className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-block h-2 w-2 rounded-full',
                  mqttConnected === null
                    ? 'bg-faint'
                    : mqttConnected
                      ? 'bg-emerald-500'
                      : 'bg-red-500',
                )}
                aria-hidden
              />
              <span className="text-foreground">
                {mqttConnected === null
                  ? t('settings.general.mqttStatusUnknown', 'Unknown')
                  : mqttConnected
                    ? t('settings.general.mqttStatusConnected', 'Connected')
                    : t('settings.general.mqttStatusDisconnected', 'Disconnected')}
              </span>
              {mqttConnected !== true ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-6 px-2 text-[11px]"
                  onClick={() => {
                    void recoverMqttConnection()
                    toast.success(t('settings.general.mqttReconnecting', 'Reconnecting…'))
                  }}
                >
                  {t('settings.general.mqttReconnect', 'Reconnect')}
                </Button>
              ) : null}
            </dd>
            {mqttConnected === false && mqttLastError ? (
              <>
                <dt className="text-muted-foreground">
                  {t('settings.general.mqttLastError', 'Last error')}
                </dt>
                <dd className="font-mono text-[11.5px] text-red-600 break-all dark:text-red-400">
                  {mqttLastError}
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="text-[12px] text-muted-foreground italic">
            {t(
              'settings.general.serverSyncedEmpty',
              'Not synced yet. Sign in once to fetch runtime configuration.',
            )}
          </p>
        )}
      </div>
    </SettingCard>
  )
}
