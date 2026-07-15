import { useTranslation } from 'react-i18next'
import { MousePointerClick } from 'lucide-react'
import { useUIStore } from '@/stores/ui'
import { useTeamShareBrowserStore, type TeamShareSection } from '@/stores/team-share-browser'
import { SkillDetail } from './SkillDetail'
import { KnowledgeDetail } from './KnowledgeDetail'
import { McpDetail } from './McpDetail'
import { EnvDetail } from './EnvDetail'

function EmptyState({ section }: { section: TeamShareSection }) {
  const { t } = useTranslation()
  const label = t(`teamShare.${section}`, section)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <MousePointerClick className="h-8 w-8 text-muted-foreground/40" />
      <p className="text-[13px] text-muted-foreground">
        {t('teamShare.selectPrompt', 'Select a {{section}} item to view it here.', { section: label })}
      </p>
    </div>
  )
}

export function TeamShareDetailPane() {
  const filter = useUIStore((s) => s.sidebarFilter)
  const section = filter.kind === 'teamShare' ? filter.section : null
  const selectedId = useTeamShareBrowserStore((s) => (section ? s.selectedId[section] : null))

  if (!section) return null
  if (!selectedId) return <EmptyState section={section} />

  switch (section) {
    case 'skills':
      return <SkillDetail key={selectedId} slug={selectedId} />
    case 'knowledge':
      return <KnowledgeDetail key={selectedId} path={selectedId} />
    case 'mcp':
      return <McpDetail key={selectedId} name={selectedId} />
    case 'env':
      return <EnvDetail key={selectedId} keyId={selectedId} />
    default:
      return null
  }
}
