import { useUIStore } from '@/stores/ui'
import { ActorsView, IdeasView } from '@/components/panel'
import { SessionListColumn } from './SessionListColumn'
import { ShortcutsListColumn } from './ShortcutsListColumn'
import { TeamShareListColumn } from './TeamShareListColumn'
import { AppsListColumn } from './AppsListColumn'
import { buildConfig } from '@/lib/build-config'

export function SidebarSecondColumn({ showNewSessionActions }: { showNewSessionActions?: boolean } = {}) {
  const embedMode = useUIStore((s) => s.embedMode)
  const filter = useUIStore((s) => s.sidebarFilter)
  if (!embedMode && filter.kind === 'shortcuts') return <ShortcutsListColumn />
  if (!embedMode && filter.kind === 'ideas') return <IdeasView />
  if (filter.kind === 'apps') return <AppsListColumn />
  if (filter.kind === 'actors') return <ActorsView />
  if (filter.kind === 'teamShare' && buildConfig.features.teamShareBrowser)
    return <TeamShareListColumn section={filter.section} />
  return <SessionListColumn showNewSessionActions={showNewSessionActions} />
}
