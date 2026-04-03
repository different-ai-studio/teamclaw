import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Network } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SectionHeader } from './shared/SectionHeader'
import { SuperAgentNetwork } from './team/SuperAgentNetwork'
import { TaskBoard } from './team/TaskBoard'
import { KnowledgeExplorer } from './team/KnowledgeExplorer'
import { DebateView } from './team/DebateView'

// ─── Tab Switcher ─────────────────────────────────────────────────────────────

type SuperAgentTab = 'network' | 'tasks' | 'knowledge' | 'deliberation'

function TabSwitcher({
  activeTab,
  onTabChange,
}: {
  activeTab: SuperAgentTab
  onTabChange: (tab: SuperAgentTab) => void
}) {
  const { t } = useTranslation()

  const tabs: { id: SuperAgentTab; labelKey: string }[] = [
    { id: 'network', labelKey: 'settings.superAgent.tabs.network' },
    { id: 'tasks', labelKey: 'settings.superAgent.tabs.tasks' },
    { id: 'knowledge', labelKey: 'settings.superAgent.tabs.knowledge' },
    { id: 'deliberation', labelKey: 'settings.superAgent.tabs.deliberation' },
  ]

  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-muted/50 p-1" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={activeTab === tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            'rounded-md px-4 py-1.5 text-sm font-medium transition-all',
            activeTab === tab.id
              ? 'bg-background shadow-sm text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {t(tab.labelKey)}
        </button>
      ))}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function SuperAgentSection() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = React.useState<SuperAgentTab>('network')

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Network}
        title={t('settings.superAgent.title', 'Super Agent')}
        description={t(
          'settings.superAgent.description',
          'Multi-agent collaboration network — task delegation, collective learning, and emergent intelligence.'
        )}
        iconColor="text-emerald-500"
      />

      <TabSwitcher activeTab={activeTab} onTabChange={setActiveTab} />

      {activeTab === 'network' && <SuperAgentNetwork />}
      {activeTab === 'tasks' && <TaskBoard />}
      {activeTab === 'knowledge' && <KnowledgeExplorer />}
      {activeTab === 'deliberation' && <DebateView />}
    </div>
  )
}
