import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useIdeasForTeam, type IdeaRow } from '@/components/panel/IdeasView'
import { useUIStore } from '@/stores/ui'
import { cn } from '@/lib/utils'

function ideaStatusLabel(status: IdeaRow['status']): { label: string; tone: string } {
  if (status === 'in_progress') return { label: 'active', tone: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' }
  if (status === 'done') return { label: 'done', tone: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' }
  return { label: 'open', tone: 'bg-muted text-muted-foreground' }
}

export function IdeasSection() {
  const { t } = useTranslation()
  const collapsed = useUIStore((s) => s.ideasSectionCollapsed)
  const toggle = useUIStore((s) => s.toggleIdeasSection)
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const { ideas, loading } = useIdeasForTeam()

  const handleClickIdea = (idea: IdeaRow) => {
    setFilter({ kind: 'idea', ideaId: idea.id, title: idea.title })
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={toggle}
        className="group flex w-full items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80 hover:text-foreground"
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        <span>{t('sidebar.ideasSection', 'Ideas')}</span>
      </button>
      {!collapsed && (
        <div className="flex flex-col">
          {loading && (
            <div className="px-2 py-1 text-[11px] text-muted-foreground">{t('ideas.loading', 'Loading ideas...')}</div>
          )}
          {!loading && ideas.length === 0 && (
            <div className="px-2 py-1 text-[11px] text-muted-foreground">{t('ideas.empty', 'No ideas yet')}</div>
          )}
          {ideas.map((idea) => {
            const active = filter.kind === 'idea' && filter.ideaId === idea.id
            const { label, tone } = ideaStatusLabel(idea.status)
            return (
              <button
                key={idea.id}
                type="button"
                onClick={() => handleClickIdea(idea)}
                className={cn(
                  'relative flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted/50',
                  active && 'bg-muted/40 font-medium before:absolute before:left-0 before:top-1/2 before:h-[72%] before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-primary',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{idea.title}</span>
                <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium', tone)}>{label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
