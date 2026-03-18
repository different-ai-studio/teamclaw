import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { TeamGitConfig } from './team/TeamGitConfig'
import { TeamP2PConfig } from './team/TeamP2PConfig'
import { TeamWebDavConfig } from './team/TeamWebDavConfig'

// ─── Tab Switcher ────────────────────────────────────────────────────────────

type TeamTab = 'p2p' | 'webdav' | 'git'

function TabSwitcher({
  activeTab,
  onTabChange,
  t,
}: {
  activeTab: TeamTab
  onTabChange: (tab: TeamTab) => void
  t: ReturnType<typeof import('react-i18next').useTranslation>['t']
}) {
  const tabs: { id: TeamTab; label: string; badge?: string }[] = [
    { id: 'p2p', label: t('settings.team.tabP2p', 'P2P') },
    { id: 'webdav', label: 'WebDAV' },
    { id: 'git', label: t('settings.team.tabGit', 'Git'), badge: t('settings.team.legacy', 'Legacy') },
  ]

  return (
    <div className="flex gap-1 rounded-lg bg-muted/50 p-1" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={activeTab === tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            "rounded-md px-4 py-1.5 text-sm font-medium transition-all",
            activeTab === tab.id
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {tab.label}
          {tab.badge && (
            <span className="ml-1.5 rounded-full bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
              {tab.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

// ─── Section Header ──────────────────────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  title,
  description,
  iconColor,
}: {
  icon: React.ElementType
  title: string
  description: string
  iconColor: string
}) {
  return (
    <div className="flex items-start gap-4 mb-6">
      <div className="rounded-xl p-3 bg-muted/50">
        <Icon className={cn("h-6 w-6", iconColor)} />
      </div>
      <div>
        <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      </div>
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TeamSection() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = React.useState<TeamTab>('p2p')

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Users}
        title={t('settings.team.title', 'Team')}
        description={t('settings.team.description', 'Connect a Git repository to share skills, MCP configs, and knowledge with your team')}
        iconColor="text-violet-500"
      />

      {/* Tab Switcher */}
      <TabSwitcher activeTab={activeTab} onTabChange={setActiveTab} t={t} />

      {/* P2P Tab */}
      {activeTab === 'p2p' && <TeamP2PConfig />}

      {/* WebDAV Tab */}
      {activeTab === 'webdav' && <TeamWebDavConfig />}

      {/* Git Tab */}
      {activeTab === 'git' && <TeamGitConfig />}
    </div>
  )
}
