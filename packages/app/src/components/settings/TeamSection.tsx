import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import {
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { TeamP2PConfig } from './team/TeamP2PConfig'
import { TeamWebDavConfig } from './team/TeamWebDavConfig'
import { TeamOSSConfig } from './team/TeamOSSConfig'
import { useTeamOssStore } from '@/stores/team-oss'
import { useWorkspaceStore } from '@/stores/workspace'

// ─── Tab Switcher ────────────────────────────────────────────────────────────

type TeamTab = 'oss' | 'p2p' | 'webdav'

function TabSwitcher({
  activeTab,
  onTabChange,
  disabledTabs,
  t,
}: {
  activeTab: TeamTab
  onTabChange: (tab: TeamTab) => void
  disabledTabs: Set<TeamTab>
  t: ReturnType<typeof import('react-i18next').useTranslation>['t']
}) {
  const tabs: { id: TeamTab; label: string }[] = [
    { id: 'oss', label: 'S3 云同步' },
    { id: 'p2p', label: t('settings.team.tabP2p', 'P2P') },
    { id: 'webdav', label: 'WebDAV' },
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
  const ossConnected = useTeamOssStore((s) => s.connected)
  const [p2pConnected, setP2pConnected] = React.useState(false)
  const [webdavConnected, setWebdavConnected] = React.useState(false)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  React.useEffect(() => {
    // Check P2P status
    invoke<{ connected: boolean }>('p2p_sync_status')
      .then((s) => setP2pConnected(s?.connected ?? false))
      .catch(() => setP2pConnected(false))

    // Check WebDAV status
    invoke<{ connected: boolean }>('webdav_get_status')
      .then((s) => setWebdavConnected(s?.connected ?? false))
      .catch(() => setWebdavConnected(false))
  }, [workspacePath])

  if (ossConnected) return 'oss'
  if (p2pConnected) return 'p2p'
  if (webdavConnected) return 'webdav'
  return null
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TeamSection() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = React.useState<TeamTab>('oss')
  const activeSyncMethod = useActiveSyncMethod()

  // If a sync method is active, lock to that tab
  React.useEffect(() => {
    if (activeSyncMethod) {
      setActiveTab(activeSyncMethod)
    }
  }, [activeSyncMethod])

  // Disable other tabs when one sync method is connected
  const disabledTabs = React.useMemo(() => {
    if (!activeSyncMethod) return new Set<TeamTab>()
    const all: TeamTab[] = ['oss', 'p2p', 'webdav']
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

      {/* Tab Switcher */}
      <TabSwitcher activeTab={activeTab} onTabChange={setActiveTab} disabledTabs={disabledTabs} t={t} />

      {/* OSS Tab */}
      {activeTab === 'oss' && <TeamOSSConfig />}

      {/* P2P Tab */}
      {activeTab === 'p2p' && <TeamP2PConfig />}

      {/* WebDAV Tab */}
      {activeTab === 'webdav' && <TeamWebDavConfig />}
    </div>
  )
}
