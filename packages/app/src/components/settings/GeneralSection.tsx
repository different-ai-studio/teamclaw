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
  Save,
  Bell,
  Shield,
  AlertTriangle,
  MessageSquareText,
  Plus,
  X,
  SlidersHorizontal,
  Keyboard,
  Loader2,
} from 'lucide-react'
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
import { SettingCard, SectionHeader, ToggleSwitch } from './shared'
import { getPermissionPolicy, setPermissionPolicy, type PermissionPolicy } from '@/lib/permission-policy'
import { PermissionBatchSection } from './PermissionBatchSection'
import { useSuggestionsStore } from '@/stores/suggestions'
import { useUIStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'
import { appShortName, buildConfig } from '@/lib/build-config'
import { getPreferredLanguage, persistLanguage } from '@/lib/locale'

// Theme helpers
const THEME_STORAGE_KEY = `${buildConfig.app.shortName ?? 'teamclaw'}-theme`
const DEFAULT_THEME = buildConfig.defaults?.theme || 'system'
const DEFAULT_SPOTLIGHT_SHORTCUT = 'alt+space'
const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift'])

function normalizeShortcutKey(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null

  if (event.code === 'Space') return 'space'
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5)
  if (/^Arrow(Up|Down|Left|Right)$/.test(event.code)) return event.code.toLowerCase()
  if (/^F\d{1,2}$/.test(event.code)) return event.code.toLowerCase()

  if (event.key.length === 1) return event.key.toLowerCase()
  return event.key.toLowerCase()
}

function shortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  const key = normalizeShortcutKey(event)
  if (!key) return null

  const parts: string[] = []
  if (event.metaKey) parts.push('cmd')
  if (event.ctrlKey) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  parts.push(key)
  return parts.join('+')
}

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
  const [autoSave, setAutoSave] = React.useState(true)
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
  const [permissionPolicy, setPermissionPolicyState] = React.useState<PermissionPolicy>(getPermissionPolicy)
  const handlePermissionPolicyChange = React.useCallback((value: string) => {
    const policy = value as PermissionPolicy
    setPermissionPolicyState(policy)
    setPermissionPolicy(policy)
  }, [])
  const [spotlightShortcut, setSpotlightShortcut] = React.useState(DEFAULT_SPOTLIGHT_SHORTCUT)
  const [savedSpotlightShortcut, setSavedSpotlightShortcut] = React.useState(DEFAULT_SPOTLIGHT_SHORTCUT)
  const [spotlightShortcutLoading, setSpotlightShortcutLoading] = React.useState(true)
  const [spotlightShortcutSaving, setSpotlightShortcutSaving] = React.useState(false)
  const [spotlightShortcutCapturing, setSpotlightShortcutCapturing] = React.useState(false)
  const [spotlightShortcutError, setSpotlightShortcutError] = React.useState<string | null>(null)

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

  React.useEffect(() => {
    let cancelled = false

    void invoke<string>('get_spotlight_shortcut')
      .then((shortcut) => {
        if (cancelled) return
        const value = shortcut || DEFAULT_SPOTLIGHT_SHORTCUT
        setSpotlightShortcut(value)
        setSavedSpotlightShortcut(value)
        setSpotlightShortcutError(null)
      })
      .catch((error) => {
        if (cancelled) return
        console.error('Failed to load spotlight shortcut', error)
        setSpotlightShortcut(DEFAULT_SPOTLIGHT_SHORTCUT)
        setSavedSpotlightShortcut(DEFAULT_SPOTLIGHT_SHORTCUT)
        setSpotlightShortcutError(t('settings.general.spotlightShortcutLoadError', 'Failed to load shortcut setting'))
      })
      .finally(() => {
        if (!cancelled) setSpotlightShortcutLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [t])

  const saveSpotlightShortcut = React.useCallback((nextShortcut: string) => {
    const shortcut = nextShortcut.trim()
    if (!shortcut || spotlightShortcutSaving) return

    const previous = savedSpotlightShortcut
    setSpotlightShortcut(shortcut)
    setSpotlightShortcutSaving(true)
    setSpotlightShortcutError(null)
    void invoke<string>('set_spotlight_shortcut', { shortcut })
      .then((saved) => {
        const value = saved || shortcut
        setSpotlightShortcut(value)
        setSavedSpotlightShortcut(value)
      })
      .catch((error) => {
        console.error('Failed to save spotlight shortcut', error)
        setSpotlightShortcut(previous)
        setSpotlightShortcutError(
          error instanceof Error
            ? error.message
            : String(error || t('settings.general.spotlightShortcutSaveError', 'Failed to save shortcut'))
        )
      })
      .finally(() => setSpotlightShortcutSaving(false))
  }, [savedSpotlightShortcut, spotlightShortcutSaving, t])

  React.useEffect(() => {
    if (!spotlightShortcutCapturing) return

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setSpotlightShortcutCapturing(false)
        return
      }

      const shortcut = shortcutFromKeyboardEvent(event)
      if (!shortcut) return

      setSpotlightShortcutCapturing(false)
      saveSpotlightShortcut(shortcut)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [saveSpotlightShortcut, spotlightShortcutCapturing])

  const themeIcons: Record<string, React.ElementType> = {
    light: Sun,
    dark: Moon,
    system: Monitor,
  }

  const spotlightShortcutDisabled = spotlightShortcutLoading || spotlightShortcutSaving

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Settings2}
        title={t('settings.general.title', 'General')}
        description={t('settings.general.description', 'Customize your application preferences')}
        iconColor="text-blue-500"
      />
      
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
                  "flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all",
                  theme === t 
                    ? "border-primary bg-primary/5" 
                    : "border-transparent bg-muted/50 hover:bg-muted"
                )}
              >
                <Icon className={cn("h-5 w-5", theme === t ? "text-primary" : "text-muted-foreground")} />
                <span className={cn("text-sm capitalize", theme === t ? "font-medium" : "text-muted-foreground")}>
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
  <label className="text-sm font-medium flex items-center gap-2">
    <Languages className="h-4 w-4 text-muted-foreground" />
    {t('common.language')}
  </label>
  <Select
    value={language}
    onValueChange={(value) => {
      setLanguage(value);
      i18next.changeLanguage(value);
      persistLanguage(value);
      // Sync locale to config file for gateway i18n
      invoke('set_config_locale', { locale: value }).catch(console.error);
    }}
  >
    <SelectTrigger className="h-11">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="en">🇺🇸 {t('common.english', 'English')}</SelectItem>
      <SelectItem value="zh-CN">🇨🇳 {t('common.chinese', '中文')}</SelectItem>
      <SelectItem value="ja">🇯🇵 {t('common.japanese', '日本語')}</SelectItem>
    </SelectContent>
  </Select>
</div>
      </SettingCard>
      ) : null}

      <SettingCard>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium flex items-center gap-2">
              <Keyboard className="h-4 w-4 text-muted-foreground" />
              {t('settings.general.spotlightShortcut', 'Spotlight Shortcut')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('settings.general.spotlightShortcutDesc', 'Shortcut used to toggle the small window mode')}
            </p>
          </div>
          <Button
            variant="outline"
            type="button"
            className="h-10 w-full justify-between gap-3 font-mono text-sm"
            onClick={() => {
              setSpotlightShortcutCapturing(true)
              setSpotlightShortcutError(null)
            }}
            disabled={spotlightShortcutDisabled}
          >
            <span>
              {spotlightShortcutCapturing
                ? t('settings.general.spotlightShortcutRecording', 'Press shortcut...')
                : spotlightShortcut}
            </span>
            {spotlightShortcutSaving ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <Keyboard className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
          {spotlightShortcutError && (
            <p className="text-xs text-destructive" role="alert">
              {spotlightShortcutError}
            </p>
          )}
        </div>
      </SettingCard>

      <SettingCard>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <label className="text-sm font-medium flex items-center gap-2">
                <Save className="h-4 w-4 text-muted-foreground" />
                {t('settings.general.autoSave', 'Auto Save')}
              </label>
              <p className="text-xs text-muted-foreground">
                {t('settings.general.autoSaveDesc', 'Automatically save your work')}
              </p>
            </div>
            <ToggleSwitch enabled={autoSave} onChange={setAutoSave} />
          </div>
          
          <div className="border-t pt-4">
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2">
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
          </div>

          <div className="border-t pt-4">
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2">
                <Shield className="h-4 w-4 text-muted-foreground" />
                {t('permission.policy', 'Permission Policy')}
              </label>
              <p className="text-xs text-muted-foreground">
                {t('permission.policyDesc', 'Control how permission requests are handled')}
              </p>
              <Select value={permissionPolicy} onValueChange={handlePermissionPolicyChange}>
                <SelectTrigger className="h-11" data-testid="permission-policy-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ask">{t('permission.policyAsk', 'Ask (prompt each time)')}</SelectItem>
                  <SelectItem value="batch">{t('permission.policyBatch', 'Batch (request all at once)')}</SelectItem>
                  <SelectItem value="bypass">{t('permission.policyBypass', 'Bypass (auto-authorize)')}</SelectItem>
                </SelectContent>
              </Select>
              {permissionPolicy === 'bypass' && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {t('permission.bypassWarning', 'All permission requests will be automatically authorized. Only recommended for trusted environments (development, testing, or managed deployments).')}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </SettingCard>

      {permissionPolicy === 'batch' && (
        <PermissionBatchSection />
      )}

      <ChatSuggestionsCard />

      <AdvancedModeCard />
    </div>
  )
})

function AdvancedModeCard() {
  const { t } = useTranslation()
  const advancedMode = useUIStore(s => s.advancedMode)
  const setAdvancedMode = useUIStore(s => s.setAdvancedMode)
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const refreshFileTree = useWorkspaceStore(s => s.refreshFileTree)
  const [saving, setSaving] = React.useState(false)

  const handleAdvancedModeChange = React.useCallback((enabled: boolean) => {
    if (!workspacePath || saving) return

    setSaving(true)
    void (async () => {
      try {
        await setAdvancedMode(enabled, workspacePath)
        await refreshFileTree()
      } finally {
        setSaving(false)
      }
    })()
  }, [refreshFileTree, saving, setAdvancedMode, workspacePath])

  return (
    <SettingCard>
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <label className="text-sm font-medium flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
            {t('settings.general.advancedMode', 'Advanced Mode')}
          </label>
          <p className="text-xs text-muted-foreground">
            {t('settings.general.advancedModeDesc', 'Show system and team internal files in the file tree and enable Code mode')}
          </p>
        </div>
        <ToggleSwitch
          enabled={advancedMode}
          onChange={handleAdvancedModeChange}
          disabled={!workspacePath || saving}
        />
      </div>
    </SettingCard>
  )
}

function ChatSuggestionsCard() {
  const { t } = useTranslation()
  const customSuggestions = useSuggestionsStore(s => s.customSuggestions)
  const addSuggestion = useSuggestionsStore(s => s.addSuggestion)
  const removeSuggestion = useSuggestionsStore(s => s.removeSuggestion)
  const [newSuggestion, setNewSuggestion] = React.useState('')

  const handleAdd = React.useCallback(() => {
    const trimmed = newSuggestion.trim()
    if (!trimmed) return
    addSuggestion(trimmed)
    setNewSuggestion('')
  }, [newSuggestion, addSuggestion])

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAdd()
    }
  }, [handleAdd])

  const builtInSuggestions = [
    t('chat.suggestions.analyze', 'Analyze data'),
    t('chat.suggestions.report', 'Write a report'),
    t('chat.suggestions.skill', 'Add a new skill'),
  ]

  return (
    <SettingCard>
      <h4 className="font-medium mb-4 flex items-center gap-2">
        <MessageSquareText className="h-4 w-4 text-muted-foreground" />
        {t('settings.general.chatSuggestions', 'Chat Suggestions')}
      </h4>
      <p className="text-xs text-muted-foreground mb-4">
        {t('settings.general.chatSuggestionsDesc', 'Custom suggestions shown on the Start a New Chat page')}
      </p>

      <div className="space-y-3">
        <div className="text-xs text-muted-foreground font-medium">
          {t('settings.general.builtInSuggestions', 'Built-in Suggestions')}
        </div>
        <div className="flex flex-wrap gap-2">
          {builtInSuggestions.map((s) => (
            <span
              key={s}
              className="inline-flex items-center h-8 px-3 rounded-full border text-xs bg-muted/50 text-muted-foreground"
            >
              {s}
            </span>
          ))}
        </div>

        {customSuggestions.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-2">
            {customSuggestions.map((s, i) => (
              <span
                key={`${i}-${s}`}
                className="inline-flex items-center gap-1 h-8 pl-3 pr-1 rounded-full border text-xs bg-primary/5 border-primary/20"
              >
                {s}
                <button
                  onClick={() => removeSuggestion(i)}
                  className="ml-1 p-0.5 rounded-full hover:bg-destructive/10 hover:text-destructive transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {customSuggestions.length === 0 && (
          <p className="text-xs text-muted-foreground italic pt-1">
            {t('settings.general.noCustomSuggestions', 'No custom suggestions yet')}
          </p>
        )}

        <div className="flex gap-2 pt-2">
          <Input
            value={newSuggestion}
            onChange={(e) => setNewSuggestion(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('settings.general.suggestionPlaceholder', 'Enter a suggestion text...')}
            className="h-9 text-sm"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-9 shrink-0"
            onClick={handleAdd}
            disabled={!newSuggestion.trim()}
          >
            <Plus className="h-4 w-4 mr-1" />
            {t('settings.general.addSuggestion', 'Add')}
          </Button>
        </div>
      </div>
    </SettingCard>
  )
}
