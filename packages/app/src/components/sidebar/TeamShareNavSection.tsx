import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Plug, Box, Bookmark } from 'lucide-react'
import { useUIStore } from '@/stores/ui'
import { useTeamShareBrowserStore, type TeamShareSection } from '@/stores/team-share-browser'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import { cn } from '@/lib/utils'

interface SectionDef {
  section: TeamShareSection
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
  fallback: string
}

const SECTIONS: SectionDef[] = [
  { section: 'skills', icon: Sparkles, labelKey: 'teamShare.skills', fallback: 'Skills' },
  { section: 'mcp', icon: Plug, labelKey: 'teamShare.mcp', fallback: 'MCP' },
  { section: 'env', icon: Box, labelKey: 'teamShare.env', fallback: 'Team Env' },
  { section: 'knowledge', icon: Bookmark, labelKey: 'teamShare.knowledge', fallback: 'Knowledge' },
]

interface RowProps {
  label: string
  icon: React.ComponentType<{ className?: string }>
  active: boolean
  count: number
  /** Items in this section that have stopped and need a decision. */
  needsAttention?: number
  attentionLabel?: string
  onClick: () => void
}

function SectionRow({
  label,
  icon: Icon,
  active,
  count,
  needsAttention = 0,
  attentionLabel,
  onClick,
}: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-[9px] py-[7px] text-left text-[13px] transition-[background-color,box-shadow,color] duration-150',
        active
          ? 'bg-paper font-semibold text-foreground shadow-[0_1px_2px_rgba(28,27,25,0.04)] ring-1 ring-black/[0.05]'
          : 'text-ink-2 hover:bg-black/[0.04]',
      )}
    >
      <Icon className={cn('h-[15px] w-[15px] shrink-0', active ? 'text-foreground' : 'text-muted-foreground')} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/*
        The one thing in this panel that reaches out. Auto-follow means a member
        may never open the skills section, so a paused update has no other way
        to be noticed — a full-ink dot against a faint count is enough contrast
        to register without spending the brand accent on it.
      */}
      {needsAttention > 0 && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground"
          aria-label={attentionLabel}
          title={attentionLabel}
        />
      )}
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">{count}</span>
    </button>
  )
}

export function TeamShareNavSection() {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)
  const loadCounts = useTeamShareBrowserStore((s) => s.loadCounts)
  const skillsCount = useTeamShareBrowserStore((s) => s.skills.items.length)
  const mcpCount = useTeamShareBrowserStore((s) => s.mcp.items.length)
  const envCount = useTeamShareBrowserStore((s) => s.envCount)
  const knowledgeCount = useTeamShareBrowserStore((s) => s.knowledge.items.length)
  const skillLocalState = useTeamShareBrowserStore((s) => s.skillLocalState)

  const skillConflicts = React.useMemo(
    () => Object.values(skillLocalState).filter((s) => s.state === 'dirty').length,
    [skillLocalState],
  )

  const counts: Record<TeamShareSection, number> = {
    skills: skillsCount,
    mcp: mcpCount,
    env: envCount,
    knowledge: knowledgeCount,
  }

  React.useEffect(() => {
    if (!currentTeamId || !workspacePath) return
    void loadCounts()
  }, [currentTeamId, workspacePath, loadCounts])

  const handleSelect = React.useCallback(
    (section: TeamShareSection) => {
      setFilter({ kind: 'teamShare', section })
      void loadSection(section, { force: true, withTools: section === 'mcp' })
      // Skills with nothing selected used to leave the main column blank. Default
      // to the marketplace browse view — same entry as the store button, so the
      // list header stays consistent with what's on the right.
      if (section === 'skills') {
        const detail = useTeamShareBrowserStore.getState().detailTarget
        const skillSelected =
          detail?.kind === 'skill' ||
          detail?.kind === 'skill-file' ||
          detail?.kind === 'marketplace' ||
          detail?.kind === 'marketplace-item'
        if (!skillSelected) {
          useTeamShareBrowserStore.getState().openDetail({ kind: 'marketplace' })
        }
      }
    },
    [setFilter, loadSection],
  )

  return (
    <div className="flex flex-col">
      {SECTIONS.map((def) => (
        <SectionRow
          key={def.section}
          label={t(def.labelKey, def.fallback)}
          icon={def.icon}
          active={filter.kind === 'teamShare' && filter.section === def.section}
          count={counts[def.section]}
          needsAttention={def.section === 'skills' ? skillConflicts : 0}
          attentionLabel={t('teamShare.skillConflictCount', '{{count}} skill needs a decision', {
            count: skillConflicts,
          })}
          onClick={() => handleSelect(def.section)}
        />
      ))}
    </div>
  )
}
