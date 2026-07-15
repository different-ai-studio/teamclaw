import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Plus, Sparkles, Plug, Box, Lock, FileText, Bookmark, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { useSidebar } from '@/components/ui/sidebar'
import { useUIStore, type SettingsSection } from '@/stores/ui'
import { useEnvVarsStore } from '@/stores/env-vars'
import { useTeamShareBrowserStore, type TeamShareSection } from '@/stores/team-share-browser'

const SECTION_META: Record<
  TeamShareSection,
  { icon: React.ComponentType<{ className?: string }>; titleKey: string; titleFallback: string; settings: SettingsSection }
> = {
  skills: { icon: Sparkles, titleKey: 'teamShare.skills', titleFallback: 'Skills', settings: 'skills' },
  mcp: { icon: Plug, titleKey: 'teamShare.mcp', titleFallback: 'MCP', settings: 'mcp' },
  env: { icon: Box, titleKey: 'teamShare.env', titleFallback: 'Team Env', settings: 'envVars' },
  knowledge: { icon: Bookmark, titleKey: 'teamShare.knowledge', titleFallback: 'Knowledge', settings: 'knowledge' },
}

interface RowProps {
  active: boolean
  icon: React.ComponentType<{ className?: string }>
  iconTint?: string
  title: string
  titleMono?: boolean
  subtitle?: string
  statusDot?: 'ready' | 'failed' | 'idle'
  onClick: () => void
}

function ItemRow({ active, icon: Icon, iconTint, title, titleMono, subtitle, statusDot, onClick }: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-3 border-l-2 px-4 py-2.5 text-left transition-colors',
        active ? 'border-coral bg-selected/50' : 'border-transparent hover:bg-selected/40',
      )}
    >
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
          iconTint ?? 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="h-[15px] w-[15px]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate text-[13.5px] font-semibold text-foreground', titleMono && 'font-mono text-[12.5px]')}>
          {title}
        </span>
        {subtitle && (
          <span className="flex items-center gap-1.5 truncate text-[11.5px] text-muted-foreground">
            {statusDot && (
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  statusDot === 'ready' && 'bg-emerald-500',
                  statusDot === 'failed' && 'bg-amber-500',
                  statusDot === 'idle' && 'bg-muted-foreground/40',
                )}
              />
            )}
            <span className="truncate">{subtitle}</span>
          </span>
        )}
      </span>
    </button>
  )
}

export function TeamShareListColumn({ section }: { section: TeamShareSection }) {
  const { t } = useTranslation()
  const { state: sidebarState } = useSidebar()
  const sidebarCollapsed = sidebarState === 'collapsed'
  const meta = SECTION_META[section]

  const openSettings = useUIStore((s) => s.openSettings)
  const selected = useTeamShareBrowserStore((s) => s.selectedId[section])
  const select = useTeamShareBrowserStore((s) => s.select)
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)

  const skills = useTeamShareBrowserStore((s) => s.skills)
  const mcp = useTeamShareBrowserStore((s) => s.mcp)
  const knowledge = useTeamShareBrowserStore((s) => s.knowledge)
  const teamSecrets = useEnvVarsStore((s) => s.teamSecrets)

  const [query, setQuery] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)

  // Reset transient UI when switching section; ensure data is loaded.
  React.useEffect(() => {
    setQuery('')
    setSearchOpen(false)
    void loadSection(section, { withTools: section === 'mcp' })
  }, [section, loadSection])

  const loading =
    section === 'skills' ? skills.loading : section === 'mcp' ? mcp.loading : section === 'knowledge' ? knowledge.loading : false

  const count =
    section === 'skills'
      ? skills.items.length
      : section === 'mcp'
        ? mcp.items.length
        : section === 'knowledge'
          ? knowledge.items.length
          : teamSecrets.length

  const q = query.trim().toLowerCase()

  const rows = React.useMemo(() => {
    if (section === 'skills') {
      return skills.items
        .filter((s) => !q || s.name.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q))
        .map((s) => ({
          id: s.slug,
          icon: Sparkles,
          iconTint: 'bg-coral/10 text-coral',
          title: s.name,
          subtitle: s.category ?? s.invocationName,
        }))
    }
    if (section === 'mcp') {
      return mcp.items
        .filter((m) => !q || m.name.toLowerCase().includes(q))
        .map((m) => {
          const statusDot: 'ready' | 'failed' | 'idle' =
            m.probeStatus === 'ready' ? 'ready' : m.probeStatus === 'failed' ? 'failed' : 'idle'
          const statusLabel =
            m.probeStatus === 'ready'
              ? t('teamShare.mcpDetail.connected', 'Connected')
              : m.probeStatus === 'failed'
                ? t('teamShare.mcpDetail.failed', 'Needs attention')
                : t('teamShare.mcpDetail.idle', 'Idle')
          return {
            id: m.name,
            icon: Plug,
            iconTint: 'bg-muted text-muted-foreground',
            title: m.name,
            subtitle: `${statusLabel} · ${t('teamShare.mcpDetail.toolCount', '{{count}} tools', { count: m.tools.length })}`,
            statusDot,
          }
        })
    }
    if (section === 'knowledge') {
      return knowledge.items
        .filter((k) => !q || k.name.toLowerCase().includes(q) || k.relPath.toLowerCase().includes(q))
        .map((k) => {
          const dir = k.relPath.includes('/') ? k.relPath.slice(0, k.relPath.lastIndexOf('/')) : ''
          return {
            id: k.path,
            icon: FileText,
            iconTint: 'bg-coral/10 text-coral',
            title: k.name,
            subtitle: dir || t('teamShare.knowledgeRoot', 'Root'),
          }
        })
    }
    // env
    return teamSecrets
      .filter((e) => !q || e.keyId.toLowerCase().includes(q))
      .map((e) => ({
        id: e.keyId,
        icon: e.category === 'config' ? Box : Lock,
        iconTint: 'bg-muted text-muted-foreground',
        title: e.keyId,
        titleMono: true,
        subtitle: e.category || t('teamShare.envDetail.secret', 'Secret'),
      }))
  }, [section, q, skills.items, mcp.items, knowledge.items, teamSecrets, t])

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3" data-tauri-drag-region>
        {sidebarCollapsed && (
          <div className="flex shrink-0 items-center gap-1">
            <TrafficLights />
            <SidebarCollapseToggle />
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <meta.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="truncate text-[15px] font-bold tracking-tight text-foreground">
            {t(meta.titleKey, meta.titleFallback)}
            <span className="font-mono text-[11px] font-normal text-faint"> · {count}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setSearchOpen((v) => !v)}
            title={t('common.search', 'Search')}
          >
            <Search className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => openSettings(meta.settings)}
            title={t('teamShare.manageInSettings', 'Manage in settings')}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {searchOpen && (
        <div className="border-b border-border px-3 py-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('common.search', 'Search')}
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none focus:border-coral/60"
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
            {t('teamShare.empty', 'Nothing shared with the team yet.')}
          </div>
        ) : (
          rows.map((row) => (
            <ItemRow
              key={row.id}
              active={selected === row.id}
              icon={row.icon}
              iconTint={row.iconTint}
              title={row.title}
              titleMono={'titleMono' in row ? (row.titleMono as boolean) : false}
              subtitle={row.subtitle}
              statusDot={'statusDot' in row ? (row.statusDot as 'ready' | 'failed' | 'idle') : undefined}
              onClick={() => select(section, row.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}
