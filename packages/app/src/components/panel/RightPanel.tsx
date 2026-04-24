import { SessionDiffPanel } from '@/components/chat/SessionDiffPanel'
import { SessionList } from '@/components/chat/SessionList'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import { ShortcutsPanel } from './ShortcutsPanel'
import { KnowledgeBrowser } from '@/components/knowledge/KnowledgeBrowser'
import { useWorkspaceStore } from '@/stores/workspace'
import { useSessionStore } from '@/stores/session'
import type { FileDiff } from '@/lib/opencode/sdk-types'
import type { ComponentProps } from 'react'

interface RightPanelProps {
  diff?: FileDiff[]
  // Override the active tab from store
  defaultTab?: 'diff' | 'files' | 'session' | 'shortcuts' | 'knowledge'
  // Compact mode for file mode layout
  compact?: boolean
  knowledgeBrowserProps?: ComponentProps<typeof KnowledgeBrowser>
}

export function RightPanel({ diff, defaultTab, compact, knowledgeBrowserProps }: RightPanelProps) {
  const storeActiveTab = useWorkspaceStore(s => s.activeTab)
  const sessionDiff = useSessionStore(s => s.sessionDiff)

  // Use defaultTab if provided, otherwise use store's activeTab
  const activeTab = defaultTab || storeActiveTab
  const diffData = diff ?? sessionDiff

  return (
    <div className={`h-full overflow-auto ${activeTab === 'files' || activeTab === 'session' ? '' : (compact ? 'p-1' : 'p-2')}`}>
      {activeTab === 'shortcuts' && (
        <ShortcutsPanel />
      )}
      {activeTab === 'diff' && (
        <DiffTab diff={diffData} compact={compact} />
      )}
      {activeTab === 'files' && (
        <FileBrowser variant={compact ? 'panel' : 'default'} />
      )}
      {activeTab === 'session' && (
        <SessionList compact={compact} />
      )}
      {activeTab === 'knowledge' && (
        <KnowledgeBrowser {...knowledgeBrowserProps} />
      )}
    </div>
  )
}

// Diff tab content
function DiffTab({ diff, compact }: { diff: FileDiff[], compact?: boolean }) {
  if (diff.length === 0) {
    return (
      <div className={`text-muted-foreground text-center ${compact ? 'text-xs py-3' : 'text-xs py-4'}`}>
        No changes yet
      </div>
    )
  }

  return <SessionDiffPanel diff={diff} compact={compact} />
}
