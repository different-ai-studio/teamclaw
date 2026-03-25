import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import {
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { TeamP2PConfig } from './team/TeamP2PConfig'
import { TeamOSSConfig } from './team/TeamOSSConfig'
import { useTeamOssStore } from '@/stores/team-oss'
import { useWorkspaceStore } from '@/stores/workspace'

// ─── Tab Switcher ────────────────────────────────────────────────────────────

type TeamTab = 'p2p' | 's3'

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
  ]

  return (
    <div className="flex gap-1 rounded-lg bg-muted/50 p-1" role="tablist">
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
              "rounded-md px-4 py-1.5 text-sm font-medium transition-all",
              disabled
                ? "text-muted-foreground/40 cursor-not-allowed"
                : activeTab === tab.id
                  ? "bg-background shadow-sm text-foreground"
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

// ─── Hook: detect which sync method is active ───────────────────────────────

function useActiveSyncMethod(): TeamTab | null {
  const ossConfigured = useTeamOssStore((s) => s.configured)
  const ossConnected = useTeamOssStore((s) => s.connected)
  const [p2pConnected, setP2pConnected] = React.useState(false)
  const [p2pConfigured, setP2pConfigured] = React.useState(false)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  React.useEffect(() => {
    invoke<{ connected: boolean; namespaceId?: string | null }>('p2p_sync_status')
      .then((s) => {
        setP2pConnected(s?.connected ?? false)
        // P2P is configured if it has a namespace (team was created/joined)
        setP2pConfigured(!!s?.namespaceId)
      })
      .catch(() => {
        setP2pConnected(false)
        setP2pConfigured(false)
      })
  }, [workspacePath])

  // Prefer connected state, fall back to configured state
  if (p2pConnected) return 'p2p'
  if (ossConnected) return 's3'
  if (p2pConfigured) return 'p2p'
  if (ossConfigured) return 's3'
  return null
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TeamSection() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = React.useState<TeamTab>('p2p')
  const activeSyncMethod = useActiveSyncMethod()

  React.useEffect(() => {
    setActiveTab(activeSyncMethod ?? 'p2p')
  }, [activeSyncMethod])

  const disabledTabs = React.useMemo(() => {
    if (!activeSyncMethod) return new Set<TeamTab>()
    const all: TeamTab[] = ['p2p', 's3']
    return new Set(all.filter((t) => t !== activeSyncMethod))
  }, [activeSyncMethod])

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Users}
        title={t('settings.team.title', 'Team')}
        description={t('settings.team.description', '连接云存储以与团队共享技能、MCP 配置和知识库')}
        iconColor="text-violet-500"
      />

      <TabSwitcher activeTab={activeTab} onTabChange={setActiveTab} disabledTabs={disabledTabs} />

      {activeTab === 'p2p' && <TeamP2PConfig />}
      {activeTab === 's3' && <TeamOSSConfig />}
    </div>
  )
}
