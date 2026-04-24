import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Brain,
  Settings2,
  MessageSquareText,
  MessageSquare,
  Plug,
  Sparkles,
  UserRound,
  Users,
  Package,
  Clock,
  KeyRound,
  Coins,
  Shield,
  SlidersHorizontal,
  BookOpen,
  Mic,
  Bookmark,
  ChevronDown,
  Loader2,
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
  color: string
}

// Primary sections shown directly in sidebar
const primarySections: Section[] = [
  { id: 'general', label: 'General', labelKey: 'settings.nav.general', icon: Settings2, color: 'text-blue-500' },
  { id: 'shortcuts', label: 'Shortcuts', labelKey: 'settings.nav.shortcuts', icon: Bookmark, color: 'text-amber-500' },
  { id: 'channels', label: 'Channels', labelKey: 'settings.nav.channels', icon: MessageSquare, color: 'text-indigo-500' },
  { id: 'automation', label: 'Automation', labelKey: 'settings.nav.automation', icon: Clock, color: 'text-amber-500' },
  { id: 'team', label: 'Team', labelKey: 'settings.nav.team', icon: Users, color: 'text-violet-500' },
  { id: 'tokenUsage', label: 'Token Usage', labelKey: 'settings.nav.tokenUsage', icon: Coins, color: 'text-rose-500' },
]

// Advanced sections shown as tabs inside the Advanced view
const advancedSections: Section[] = [
  { id: 'voice', label: 'Voice', labelKey: 'settings.nav.voice', icon: Mic, color: 'text-pink-500' },
  { id: 'llm', label: 'LLM Model', labelKey: 'settings.nav.llm', icon: Brain, color: 'text-purple-500' },
  { id: 'prompt', label: 'Prompt', labelKey: 'settings.nav.prompt', icon: MessageSquareText, color: 'text-green-500' },
  { id: 'permissions', label: 'Permissions', labelKey: 'settings.nav.permissions', icon: Shield, color: 'text-emerald-500' },
  { id: 'mcp', label: 'MCP', labelKey: 'settings.nav.mcp', icon: Plug, color: 'text-orange-500' },
  { id: 'envVars', label: 'Env Variables', labelKey: 'settings.nav.envVars', icon: KeyRound, color: 'text-emerald-500' },
  { id: 'roles', label: 'Roles', labelKey: 'settings.nav.roles', icon: UserRound, color: 'text-sky-500' },
  { id: 'skills', label: 'Skills', labelKey: 'settings.nav.skills', icon: Sparkles, color: 'text-yellow-500' },
  { id: 'knowledge', label: 'Knowledge Base', labelKey: 'settings.nav.knowledge', icon: BookOpen, color: 'text-cyan-500' },
  { id: 'deps', label: 'Dependencies', labelKey: 'settings.nav.deps', icon: Package, color: 'text-teal-500' },
  { id: 'privacy', label: 'Privacy & Telemetry', labelKey: 'settings.nav.privacy', icon: Shield, color: 'text-slate-500' },
]

function UpdateButton() {
  const { t } = useTranslation()
  const update = useUpdaterStore(s => s.update)
  const checkForUpdates = useUpdaterStore(s => s.checkForUpdates)
  const restart = useUpdaterStore(s => s.restart)

  if (update.state === 'ready') {
    return (
      <Button variant="default" size="sm" className="h-6 text-[11px] px-2" onClick={() => restart()}>
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
      <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1 tabular-nums">
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
      className="h-6 text-[11px] px-2 text-muted-foreground"
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
    <div className="flex h-full">
      {/* Sidebar navigation */}
      <div className="w-60 border-r bg-muted/20 flex flex-col">
        <div className="flex items-center gap-2 p-4 border-b">
          <Settings2 className="h-5 w-5 text-muted-foreground" />
          <h2 className="font-semibold">{t('settings.title', 'Settings')}</h2>
        </div>
        <ScrollArea className="flex-1 overflow-hidden py-2">
          <div className="px-2 space-y-0.5">
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
                    'w-full flex items-center gap-3 px-3 py-2.5 text-sm rounded-lg transition-all relative',
                    isActive
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  )}
                >
                  {isActive && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-primary rounded-r-full" />
                  )}
                  <Icon className={cn(
                    "h-4 w-4 transition-colors",
                    isActive ? section.color : ""
                  )} />
                  {t(section.labelKey, section.label)}
                </button>
              )
            })}

            {/* Divider */}
            <div className="!my-2 border-t mx-3" />

            {/* Advanced category */}
            <button
              onClick={() => setAdvancedExpanded(!advancedExpanded)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2.5 text-sm rounded-lg transition-all relative',
                (advancedExpanded || isAdvancedSection)
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              {(advancedExpanded || isAdvancedSection) && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-primary rounded-r-full" />
              )}
              <SlidersHorizontal className={cn(
                "h-4 w-4 transition-colors",
                (advancedExpanded || isAdvancedSection) ? 'text-gray-500' : ""
              )} />
              {t('settings.nav.advanced', 'Advanced')}
              <ChevronDown className={cn(
                "h-4 w-4 ml-auto transition-transform",
                advancedExpanded ? "rotate-180" : ""
              )} />
            </button>

            {/* Advanced sub-sections */}
            {advancedExpanded && (
              <div className="pl-6 space-y-0.5 mt-1">
                {advancedSections.map((section) => {
                  const Icon = section.icon
                  const isActive = activeView === section.id
                  return (
                    <button
                      key={section.id}
                      onClick={() => setActiveView(section.id)}
                      className={cn(
                        'w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-all relative',
                        isActive
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                      )}
                    >
                      {isActive && (
                        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-4 bg-primary rounded-r-full" />
                      )}
                      <Icon className={cn(
                        "h-3.5 w-3.5 transition-colors",
                        isActive ? section.color : ""
                      )} />
                      <span className="text-xs">{t(section.labelKey, section.label)}</span>
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
        <div className="px-4 py-3 border-t flex items-center justify-between">
          <span className="text-xs text-muted-foreground select-none cursor-default">
            v{appVersion}
          </span>
          <UpdateButton />
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 flex flex-col min-w-0">
        <SettingsSectionBody section={activeView} />
      </div>
    </div>
  )
}
