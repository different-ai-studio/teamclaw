import { useUIStore } from '@/stores/ui'
import { SessionListColumn } from './SessionListColumn'
import { ShortcutsListColumn } from './ShortcutsListColumn'

export function SidebarSecondColumn() {
  const filter = useUIStore((s) => s.sidebarFilter)
  if (filter.kind === 'shortcuts') return <ShortcutsListColumn />
  return <SessionListColumn />
}
