import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Settings2,
  MessageSquare,
  Users,
  KeyRound,
  Coins,
  Shield,
  SlidersHorizontal,
  BookOpen,
  Mic,
  Bookmark,
  ChevronDown,
  Loader2,
  Database,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { useAppVersion } from '@/lib/version'
import { useUpdaterStore } from '@/stores/updater'
import { buildConfig, hasAnyChannel } from '@/lib/build-config'
import { useTeamModeStore } from '@/stores/team-mode'
import { useUIStore, type SettingsSection } from '@/stores/ui'
import { TeamRankingCard } from './TeamRankingCard'
import { SettingsSectionBody } from './section-registry'

interface SettingsProps {
  onClose?: () => void
}

interface Section {
  id: SettingsSection
  label: string
  labelKey: string
  icon: React.ElementType
}

// Primary sections shown directly in sidebar
const primarySections: Section[] = [
  { id: 'general', label: 'General', labelKey: 'settings.nav.general', icon: Settings2 },
  { id: 'shortcuts', label: 'Shortcuts', labelKey: 'settings.nav.shortcuts', icon: Bookmark },
  { id: 'channels', label: 'Channels', labelKey: 'settings.nav.channels', icon: MessageSquare },
  { id: 'team', label: 'Team', labelKey: 'settings.nav.team', icon: Users },
  { id: 'tokenUsage', label: 'Token Usage', labelKey: 'settings.nav.tokenUsage', icon: Coins },
]

// Advanced sections shown as tabs inside the Advanced view
const advancedSections: Section[] = [
  { id: 'voice', label: 'Voice', labelKey: 'settings.nav.voice', icon: Mic },
  { id: 'envVars', label: 'Env Variables', labelKey: 'settings.nav.envVars', icon: KeyRound },
  { id: 'knowledge', label: 'Knowledge Base', labelKey: 'settings.nav.knowledge', icon: BookOpen },
  { id: 'privacy', label: 'Privacy & Telemetry', labelKey: 'settings.nav.privacy', icon: Shield },
  { id: 'cache', label: 'Local Cache', labelKey: 'settings.nav.cache', icon: Database },
]

function UpdateButton() {
  const { t } = useTranslation()
  const update = useUpdaterStore(s => s.update)
  const checkForUpdates = useUpdaterStore(s => s.checkForUpdates)
  const restart = useUpdaterStore(s => s.restart)

  if (update.state === 'ready') {
    return (
      <Button variant="default" size="sm" className="h-6 px-2 text-[11px]" onClick={() => restart()}>
        {t('settings.update.restart', 'Restart')}
      </Button>
    )
  }

  if (update.state === 'available' || update.state === 'downloading') {
    const pct =
      update.state === 'downloading' &&
      update.progress != null &&
      update.progress > 0
        ? ` ${update.progress}%`
        : ''
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[11px] text-faint tabular-nums">
        <Loader2 className="h-3 w-3 animate-spin shrink-0" aria-hidden />
        <span>
          {t('settings.update.updating', 'Updating…')}
          {pct}
        </span>
      </span>
    )
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-[11px] text-muted-foreground hover:bg-selected hover:text-foreground"
      onClick={() => checkForUpdates()}
      disabled={update.state === 'checking'}
    >
      {update.state === 'checking'
        ? `${t('settings.update.checking', 'Checking')}...`
        : update.state === 'up-to-date'
          ? t('settings.update.upToDate', 'Up to date')
          : t('settings.update.check', 'Check for updates')}
    </Button>
  )
}

export function Settings(_props?: SettingsProps) {
  const { t } = useTranslation()
  const settingsInitialSection = useUIStore(s => s.settingsInitialSection)
  const [activeView, setActiveView] = React.useState<SettingsSection>(settingsInitialSection ?? 'general')
  const [advancedExpanded, setAdvancedExpanded] = React.useState(false)
  const appVersion = useAppVersion()
  const teamMode = useTeamModeStore(s => s.teamMode)

  // Filter sections based on build config feature flags
  const filteredPrimarySections = React.useMemo(() =>
    primarySections.filter(s => s.id !== 'channels' || hasAnyChannel(buildConfig.features.channels)),
    []
  )

  // Check if current view is an advanced section
  const isAdvancedSection = advancedSections.some(s => s.id === activeView)

  // Auto-expand advanced when an advanced section is active
  React.useEffect(() => {
    if (isAdvancedSection) {
      setAdvancedExpanded(true)
    }
  }, [isAdvancedSection])

  return (
    <div className="flex h-full bg-background text-foreground">
      {/* Sidebar navigation */}
      <div className="flex w-60 flex-col border-r border-border bg-panel">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <Settings2 className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-[15px] font-semibold">{t('settings.title', 'Settings')}</h2>
        </div>
        <ScrollArea className="flex-1 overflow-hidden py-2">
          <div className="space-y-0.5 px-2">
            {filteredPrimarySections.map((section) => {
              const Icon = section.icon
              const isActive = activeView === section.id
              return (
                <button
                  key={section.id}
                  onClick={() => {
                    setActiveView(section.id)
                    setAdvancedExpanded(false)
                  }}
                  className={cn(
                    'relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-colors',
                    isActive
                      ? 'bg-selected text-foreground font-semibold'
                      : 'text-muted-foreground hover:bg-selected/60 hover:text-foreground'
                  )}
                >
                  {isActive && (
                    <div className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-foreground/70" />
                  )}
                  <Icon className={cn("h-4 w-4 transition-colors", isActive ? "text-foreground" : "text-muted-foreground")} />
                  {t(section.labelKey, section.label)}
                </button>
              )
            })}

            {/* Divider */}
            <div className="!my-2 mx-3 border-t border-border-soft" />

            {/* Advanced category */}
            <button
              onClick={() => setAdvancedExpanded(!advancedExpanded)}
              className={cn(
                'relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-colors',
                (advancedExpanded || isAdvancedSection)
                  ? 'bg-selected text-foreground font-semibold'
                  : 'text-muted-foreground hover:bg-selected/60 hover:text-foreground'
              )}
            >
              {(advancedExpanded || isAdvancedSection) && (
                <div className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-foreground/70" />
              )}
              <SlidersHorizontal className={cn(
                "h-4 w-4 transition-colors",
                (advancedExpanded || isAdvancedSection) ? 'text-foreground' : 'text-muted-foreground'
              )} />
              {t('settings.nav.advanced', 'Advanced')}
              <ChevronDown className={cn(
                "h-4 w-4 ml-auto transition-transform",
                advancedExpanded ? "rotate-180" : ""
              )} />
            </button>

            {/* Advanced sub-sections */}
            {advancedExpanded && (
              <div className="mt-1 space-y-0.5 pl-6">
                {advancedSections.map((section) => {
                  const Icon = section.icon
                  const isActive = activeView === section.id
                  return (
                    <button
                      key={section.id}
                      onClick={() => setActiveView(section.id)}
                      className={cn(
                        'relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[12px] transition-colors',
                        isActive
                          ? 'bg-selected text-foreground font-semibold'
                          : 'text-muted-foreground hover:bg-selected/60 hover:text-foreground'
                      )}
                    >
                      {isActive && (
                        <div className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-foreground/70" />
                      )}
                      <Icon className={cn("h-3.5 w-3.5 transition-colors", isActive ? "text-foreground" : "text-muted-foreground")} />
                      <span>{t(section.labelKey, section.label)}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Team Ranking Card */}
        {teamMode && (
          <div className="px-3 pb-2">
            <TeamRankingCard onClick={() => setActiveView('leaderboard')} />
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <span className="cursor-default select-none font-mono text-[11px] text-faint">
            v{appVersion}
          </span>
          <UpdateButton />
        </div>
      </div>

      {/* Content area */}
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <SettingsSectionBody section={activeView} />
      </div>
    </div>
  )
}
