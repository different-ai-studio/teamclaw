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
  const tabs: { id: SuperAgentTab; label: string }[] = [
    { id: 'network', label: 'Agent Network' },
    { id: 'tasks', label: 'Task Board' },
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'deliberation', label: 'Deliberation' },
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
          {tab.label}
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
