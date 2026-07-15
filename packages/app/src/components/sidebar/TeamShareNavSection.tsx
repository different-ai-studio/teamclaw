import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Plug, Box, Bookmark, ChevronDown, ChevronUp } from 'lucide-react'
import { useUIStore } from '@/stores/ui'
import { useTeamShareBrowserStore, type TeamShareSection } from '@/stores/team-share-browser'
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
  onClick: () => void
}

function SectionRow({ label, icon: Icon, active, count, onClick }: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-[9px] py-[7px] text-left text-[13px] transition-colors',
        active ? 'bg-selected font-semibold text-foreground' : 'text-ink-2 hover:bg-selected/60',
      )}
    >
      <Icon className={cn('h-[15px] w-[15px] shrink-0', active ? 'text-foreground' : 'text-muted-foreground')} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">{count}</span>
    </button>
  )
}

export function TeamShareNavSection() {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const collapsed = useUIStore((s) => s.teamShareCollapsed)
  const toggle = useUIStore((s) => s.toggleTeamShareSection)

  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)
  const loadCounts = useTeamShareBrowserStore((s) => s.loadCounts)
  const skillsCount = useTeamShareBrowserStore((s) => s.skills.items.length)
  const mcpCount = useTeamShareBrowserStore((s) => s.mcp.items.length)
  const envCount = useTeamShareBrowserStore((s) => s.envCount)
  const knowledgeCount = useTeamShareBrowserStore((s) => s.knowledge.items.length)

  const counts: Record<TeamShareSection, number> = {
    skills: skillsCount,
    mcp: mcpCount,
    env: envCount,
    knowledge: knowledgeCount,
  }

  // Refresh counts whenever the group is open.
  React.useEffect(() => {
    if (!collapsed) void loadCounts()
  }, [collapsed, loadCounts])

  const handleSelect = React.useCallback(
    (section: TeamShareSection) => {
      setFilter({ kind: 'teamShare', section })
      void loadSection(section, { withTools: section === 'mcp' })
    },
    [setFilter, loadSection],
  )

  return (
    <div className="flex flex-col">
      {/* Divider with centered chevron toggle */}
      <div className="relative flex items-center py-1.5">
        <div className="h-px flex-1 bg-border/60" />
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={t('teamShare.toggle', 'Team shared')}
          className="mx-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:text-foreground"
        >
          {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
        <div className="h-px flex-1 bg-border/60" />
      </div>

      {!collapsed && (
        <div className="flex flex-col">
          {SECTIONS.map((def) => (
            <SectionRow
              key={def.section}
              label={t(def.labelKey, def.fallback)}
              icon={def.icon}
              active={filter.kind === 'teamShare' && filter.section === def.section}
              count={counts[def.section]}
              onClick={() => handleSelect(def.section)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
