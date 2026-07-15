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
  Database,
  Server,
  FolderOpen,
  Bot,
  Laptop,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { useAppVersion } from '@/lib/version'
import { useUpdaterStore } from '@/stores/updater'
import { buildConfig, hasAnyChannel } from '@/lib/build-config'
import { useUIStore, type SettingsSection } from '@/stores/ui'
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
  { id: 'team', label: 'Team Shared', labelKey: 'settings.nav.team', icon: Users },
  { id: 'tokenUsage', label: 'Token Usage', labelKey: 'settings.nav.tokenUsage', icon: Coins },
  { id: 'voice', label: 'Voice', labelKey: 'settings.nav.voice', icon: Mic },
  { id: 'privacy', label: 'Privacy & Telemetry', labelKey: 'settings.nav.privacy', icon: Shield },
  { id: 'cache', label: 'Local Cache', labelKey: 'settings.nav.cache', icon: Database },
]

// Daemon-owned sections (the amuxd process for this machine).
const daemonSections: Section[] = [
  { id: 'daemonGeneral', label: 'General', labelKey: 'settings.nav.daemonGeneral', icon: Bot },
  { id: 'daemonWorkspaces', label: 'Workspace', labelKey: 'settings.nav.daemonWorkspaces', icon: FolderOpen },
  { id: 'automation', label: 'Automation', labelKey: 'settings.nav.automation', icon: Clock },
  { id: 'channels', label: 'Channels', labelKey: 'settings.nav.channels', icon: MessageSquare },
]

// Local Agent (opencode) config sections.
const localAgentSections: Section[] = [
  { id: 'llm', label: 'LLM Model', labelKey: 'settings.nav.llm', icon: Brain },
  { id: 'envVars', label: 'Env Variables', labelKey: 'settings.nav.envVars', icon: KeyRound },
  { id: 'prompt', label: 'Prompt', labelKey: 'settings.nav.prompt', icon: MessageSquareText },
  { id: 'mcp', label: 'MCP', labelKey: 'settings.nav.mcp', icon: Plug },
  { id: 'roles', label: 'Roles', labelKey: 'settings.nav.roles', icon: UserRound },
  { id: 'rolesSkills', label: 'Role Skills', labelKey: 'settings.nav.rolesSkills', icon: Sparkles },
  { id: 'skills', label: 'Skills', labelKey: 'settings.nav.skills', icon: Sparkles },
  { id: 'knowledge', label: 'Knowledge Base', labelKey: 'settings.nav.knowledge', icon: BookOpen },
  { id: 'deps', label: 'Dependencies', labelKey: 'settings.nav.deps', icon: Package },
]

function UpdateButton() {
  const { t } = useTranslation()
  const update = useUpdaterStore(s => s.update)
  const checkForUpdates = useUpdaterStore(s => s.checkForUpdates)
  const restart = useUpdaterStore(s => s.restart)

  if (!buildConfig.features.updater || import.meta.env.DEV) {
    return null
  }

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
  const appVersion = useAppVersion()

  // Filter sections based on build config feature flags
  const filteredPrimarySections = primarySections
  const filteredDaemonSections = React.useMemo(() =>
    daemonSections.filter(s => s.id !== 'channels' || hasAnyChannel(buildConfig.features.channels)),
    []
  )
  const filteredLocalAgentSections = React.useMemo(() => localAgentSections, [])

  type AccordionGroup = 'client' | 'daemon' | 'localAgent'
  const groupForSection = (id: SettingsSection): AccordionGroup => {
    if (filteredDaemonSections.some(s => s.id === id)) return 'daemon'
    if (filteredLocalAgentSections.some(s => s.id === id)) return 'localAgent'
    return 'client'
  }

  const [activeView, setActiveView] = React.useState<SettingsSection>(
    settingsInitialSection ?? 'general',
  )

  // Settings is split into two independent dialogs by entry point: the regular
  // entry shows the Client group; the local-daemon row's "Settings" shows the
  // Daemon + Local Agent (opencode) groups together (Client hidden). Which
  // dialog renders is derived from the active section's group.
  const clientGroup = { id: 'client' as const, label: 'Client', labelKey: 'settings.nav.client', icon: Laptop, sections: filteredPrimarySections, testid: 'client-subnav' }
  const daemonGroup = { id: 'daemon' as const, label: 'Daemon', labelKey: 'settings.nav.daemon', icon: Server, sections: filteredDaemonSections, testid: 'daemon-subnav' }
  const localAgentGroup = { id: 'localAgent' as const, label: 'Local Agent', labelKey: 'settings.nav.localAgent', icon: SlidersHorizontal, sections: filteredLocalAgentSections, testid: 'local-agent-subnav' }
  const navGroups = groupForSection(activeView) === 'client' ? [clientGroup] : [daemonGroup, localAgentGroup]
  const [expandedGroup, setExpandedGroup] = React.useState<AccordionGroup | null>(() => groupForSection(activeView))
  const toggleGroup = (group: AccordionGroup) => {
    setExpandedGroup(prev => (prev === group ? null : group))
  }

  // Keep accordion in sync when active section changes (e.g. via deep link)
  React.useEffect(() => {
    setExpandedGroup(groupForSection(activeView))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView])

  return (
    <div className="flex h-full bg-background text-foreground">
      {/* Sidebar navigation */}
      <div className="flex w-60 flex-col border-r border-border bg-background">
        <ScrollArea className="flex-1 overflow-hidden py-3">
          <div className="space-y-0.5 px-2">
            {navGroups.map((group) => {
              const GroupIcon = group.icon
              const isExpanded = expandedGroup === group.id
              return (
                <React.Fragment key={group.id}>
                  <button
                    onClick={() => toggleGroup(group.id)}
                    className={cn(
                      'relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-colors',
                      isExpanded
                        ? 'bg-selected text-foreground font-semibold'
                        : 'text-muted-foreground hover:bg-selected/60 hover:text-foreground'
                    )}
                  >
                    <GroupIcon className={cn(
                      "h-4 w-4 transition-colors",
                      isExpanded ? 'text-foreground' : 'text-muted-foreground'
                    )} />
                    {t(group.labelKey, group.label)}
                    <ChevronDown className={cn(
                      "h-4 w-4 ml-auto transition-transform duration-200",
                      isExpanded ? "rotate-180" : ""
                    )} />
                  </button>
                  <div
                    className={cn(
                      "grid transition-[grid-template-rows] duration-200 ease-out",
                      isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                    )}
                    aria-hidden={!isExpanded}
                  >
                    <div className="overflow-hidden">
                      <div
                        className={cn("mt-1 space-y-0.5 pl-6", !isExpanded && "pointer-events-none")}
                        data-testid={group.testid}
                      >
                        {group.sections.map((section) => {
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
                              <Icon className={cn("h-3.5 w-3.5 transition-colors", isActive ? "text-foreground" : "text-muted-foreground")} />
                              <span>{t(section.labelKey, section.label)}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              )
            })}
          </div>
        </ScrollArea>

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
