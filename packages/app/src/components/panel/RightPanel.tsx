import { TodoList } from '@/components/chat/TodoList'
import { SessionDiffPanel } from '@/components/chat/SessionDiffPanel'
import { SessionList } from '@/components/chat/SessionList'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import { ShortcutsPanel } from './ShortcutsPanel'
import { useWorkspaceStore } from '@/stores/workspace'
import { useSessionStore } from '@/stores/session'
import type { Todo, FileDiff } from '@/lib/opencode/types'

interface RightPanelProps {
  todos?: Todo[]
  diff?: FileDiff[]
  // Override the active tab from store
  defaultTab?: 'tasks' | 'diff' | 'files' | 'session' | 'shortcuts'
  // Compact mode for file mode layout
  compact?: boolean
}

export function RightPanel({ todos, diff, defaultTab, compact }: RightPanelProps) {
  const storeActiveTab = useWorkspaceStore(s => s.activeTab)
  const sessionTodos = useSessionStore(s => s.todos)
  const sessionDiff = useSessionStore(s => s.sessionDiff)
  
  // Use defaultTab if provided, otherwise use store's activeTab
  const activeTab = defaultTab || storeActiveTab
  
  // Use props or fall back to store data
  const todosData = todos ?? sessionTodos
  const diffData = diff ?? sessionDiff

  return (
    <div className={`h-full overflow-auto ${activeTab === 'files' || activeTab === 'session' ? '' : (compact ? 'p-1' : 'p-2')}`}>
      {activeTab === 'shortcuts' && (
        <ShortcutsPanel />
      )}
      {activeTab === 'tasks' && (
        <TasksTab todos={todosData} compact={compact} />
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
    </div>
  )
}

// Tasks tab content
function TasksTab({ todos, compact }: { todos: Todo[], compact?: boolean }) {
  if (todos.length === 0) {
    return (
      <div className={`text-muted-foreground text-center ${compact ? 'text-xs py-3' : 'text-xs py-4'}`}>
        No tasks yet
      </div>
    )
  }

  return <TodoList todos={todos} compact={compact} />
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
