import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { TeamP2PConfig } from './team/TeamP2PConfig'
import { TeamOSSConfig } from './team/TeamOSSConfig'
import { TeamGitConfig } from './team/TeamGitConfig'
import { useTeamOssStore } from '@/stores/team-oss'
import { useTeamModeStore } from '@/stores/team-mode'

// ─── Tab Switcher ────────────────────────────────────────────────────────────

type TeamTab = 'p2p' | 's3' | 'git'

function TabSwitcher({
  activeTab,
  onTabChange,
  disabledTabs,
}: {
  activeTab: TeamTab
  onTabChange: (tab: TeamTab) => void
  disabledTabs: Set<TeamTab>
}) {
  const tabs: { id: TeamTab; label: string }[] = [
    { id: 'p2p', label: 'P2P' },
    { id: 's3', label: 'S3' },
    { id: 'git', label: 'Git' },
  ]

  return (
    <div className="flex gap-1 rounded-lg bg-panel p-1" role="tablist">
      {tabs.map((tab) => {
        const disabled = disabledTabs.has(tab.id)
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            disabled={disabled}
            onClick={() => !disabled && onTabChange(tab.id)}
            className={cn(
              "rounded-md px-4 py-1.5 text-[13px] font-medium transition-colors",
              disabled
                ? "text-muted-foreground/40 cursor-not-allowed"
                : activeTab === tab.id
                  ? "bg-paper text-foreground"
                  : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── Section Header ──────────────────────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ElementType
  title: string
  description: string
  iconColor?: string
}) {
  return (
    <div className="mb-6 flex items-start gap-4">
      <div className="rounded-[14px] border border-border-soft bg-panel p-3">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div>
        <h3 className="text-[15px] font-semibold tracking-normal">{title}</h3>
        <p className="mt-1 text-[12.5px] text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

// ─── Hook: detect which sync method is active ───────────────────────────────

function useActiveSyncMethod(): TeamTab | null {
  const teamModeType = useTeamModeStore((s) => s.teamModeType)
  const ossConfigured = useTeamOssStore((s) => s.configured)
  const ossConnected = useTeamOssStore((s) => s.connected)
  const p2pConnected = useTeamModeStore((s) => s.p2pConnected)
  const p2pConfigured = useTeamModeStore((s) => s.p2pConfigured)

  // teamclaw.json is the authoritative source — use it during reconnect
  if (teamModeType === 'p2p') return 'p2p'
  if (teamModeType === 'oss') return 's3'
  if (teamModeType === 'git') return 'git'

  // Fall back to runtime connection/configured state
  if (p2pConnected) return 'p2p'
  if (ossConnected) return 's3'
  if (p2pConfigured) return 'p2p'
  if (ossConfigured) return 's3'
  return null
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TeamSection() {
  const { t } = useTranslation()
  const activeSyncMethod = useActiveSyncMethod()
  const [activeTab, setActiveTab] = React.useState<TeamTab>(activeSyncMethod ?? 'p2p')
  const initializedRef = React.useRef(false)

  // Only auto-switch tab on initial load (when activeSyncMethod first resolves),
  // never override a user's manual tab selection afterwards.
  React.useEffect(() => {
    if (!initializedRef.current && activeSyncMethod) {
      setActiveTab(activeSyncMethod)
      initializedRef.current = true
    }
  }, [activeSyncMethod])

  const disabledTabs = React.useMemo(() => {
    if (!activeSyncMethod) return new Set<TeamTab>()
    const all: TeamTab[] = ['p2p', 's3', 'git']
    return new Set(all.filter((t) => t !== activeSyncMethod))
  }, [activeSyncMethod])

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Users}
        title={t('settings.team.title', 'Team')}
        description={t('settings.team.description', 'Connect cloud storage or Git to share skills, MCP configs, and knowledge with your team')}
        iconColor="text-violet-500"
      />

      <TabSwitcher activeTab={activeTab} onTabChange={setActiveTab} disabledTabs={disabledTabs} />

      {activeTab === 'p2p' && <TeamP2PConfig />}
      {activeTab === 's3' && <TeamOSSConfig />}
      {activeTab === 'git' && <TeamGitConfig />}
    </div>
  )
}
