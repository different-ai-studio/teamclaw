import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Search,
  Sparkles,
  Plug,
  Box,
  Lock,
  FileText,
  Bookmark,
  Loader2,
  Check,
  ArrowUpCircle,
  Plus,
  AlertTriangle,
  FilePlus,
  FolderPlus,
  RefreshCw,
  Cloud,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useWorkspaceStore } from '@/stores/workspace'
import {
  createNewFile,
  createNewFolder,
} from '@/components/workspace/file-tree-operations'
import { cn } from '@/lib/utils'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { useSidebar } from '@/components/ui/sidebar'
import { useEnvVarsStore } from '@/stores/env-vars'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import {
  KnowledgeEnablePanel,
  useKnowledgeNeedsEnabling,
} from '@/components/teamshare/KnowledgeEnablePanel'
import { useTeamCloudSync } from '@/hooks/use-team-cloud-sync'
import { TEAM_SYNCED_EVENT } from '@/lib/build-config'
import {
  useTeamShareBrowserStore,
  type TeamShareSection,
  type TeamSkillKind,
} from '@/stores/team-share-browser'

const SECTION_META: Record<
  TeamShareSection,
  { icon: React.ComponentType<{ className?: string }>; titleKey: string; titleFallback: string }
> = {
  skills: { icon: Sparkles, titleKey: 'teamShare.skills', titleFallback: 'Skills' },
  mcp: { icon: Plug, titleKey: 'teamShare.mcp', titleFallback: 'MCP' },
  env: { icon: Box, titleKey: 'teamShare.env', titleFallback: 'Team Env' },
  knowledge: { icon: Bookmark, titleKey: 'teamShare.knowledge', titleFallback: 'Knowledge' },
}

interface RowProps {
  active: boolean
  icon: React.ComponentType<{ className?: string }>
  iconTint?: string
  title: string
  titleMono?: boolean
  subtitle?: string
  meta?: string
  badge?: React.ReactNode
  statusDot?: 'ready' | 'failed' | 'idle'
  trailing?: React.ReactNode
  dimmed?: boolean
  onClick: () => void
}

function ItemRow({
  active,
  icon: Icon,
  iconTint,
  title,
  titleMono,
  subtitle,
  meta,
  badge,
  statusDot,
  trailing,
  dimmed,
  onClick,
}: RowProps) {
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
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'truncate text-[13.5px] font-semibold',
              titleMono && 'font-mono text-[12.5px]',
              dimmed ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {title}
          </span>
          {badge}
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
        {meta && <span className="truncate font-mono text-[10.5px] text-faint">{meta}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center">{trailing}</span>}
    </button>
  )
}

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-4 pb-1 pt-3 first:pt-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.8px] text-faint">{label}</span>
      <span className="font-mono text-[10.5px] text-faint">· {count}</span>
    </div>
  )
}

type SkillRow = {
  id: string
  kind: TeamSkillKind
  icon: typeof Sparkles
  iconTint: string
  title: string
  subtitle?: string
  meta?: string
  badge?: React.ReactNode
  dimmed?: boolean
  trailing?: React.ReactNode
}

export function TeamShareListColumn({ section }: { section: TeamShareSection }) {
  const { t } = useTranslation()
  const { state: sidebarState } = useSidebar()
  const sidebarCollapsed = sidebarState === 'collapsed'
  const meta = SECTION_META[section]

  const selected = useTeamShareBrowserStore((s) => s.selectedId[section])
  const select = useTeamShareBrowserStore((s) => s.select)
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)
  const setCreating = useTeamShareBrowserStore((s) => s.setCreating)

  const skills = useTeamShareBrowserStore((s) => s.skills)
  const localState = useTeamShareBrowserStore((s) => s.skillLocalState)
  const mcp = useTeamShareBrowserStore((s) => s.mcp)
  const knowledge = useTeamShareBrowserStore((s) => s.knowledge)
  const teamSecrets = useEnvVarsStore((s) => s.teamSecrets)
  const knowledgeRoot = useTeamShareBrowserStore((s) => s.knowledgeRoot)
  const personalEnv = useEnvVarsStore((s) => s.envVars)

  // Only meaningful for the knowledge section, but hooks cannot be conditional.
  const needsEnabling = useKnowledgeNeedsEnabling()
  // Inline "name this thing" row at the top of the knowledge tree.
  const [rootCreating, setRootCreating] = React.useState<'file' | 'folder' | null>(null)
  const refreshFileTree = useWorkspaceStore((s) => s.refreshFileTree)
  const selectFile = useWorkspaceStore((s) => s.selectFile)

  const [query, setQuery] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)

  React.useEffect(() => {
    setQuery('')
    setSearchOpen(false)
    void loadSection(section, { force: true, withTools: section === 'mcp' })
  }, [section, loadSection])

  const [refreshing, setRefreshing] = React.useState(false)
  const handleRefresh = React.useCallback(async () => {
    setRefreshing(true)
    try {
      await loadSection(section, { force: true, withTools: section === 'mcp' })
    } finally {
      setRefreshing(false)
    }
  }, [section, loadSection])

  const { available: syncAvailable, syncing, syncNow } = useTeamCloudSync()

  // Reload after any successful cloud sync, ours or another surface's.
  React.useEffect(() => {
    const onSynced = () => {
      void loadSection(section, { force: true, withTools: section === 'mcp' })
    }
    window.addEventListener(TEAM_SYNCED_EVENT, onSynced)
    return () => window.removeEventListener(TEAM_SYNCED_EVENT, onSynced)
  }, [section, loadSection])

  const loading =
    section === 'skills'
      ? skills.loading
      : section === 'mcp'
        ? mcp.loading
        : section === 'knowledge'
          ? knowledge.loading
          : false

  const count =
    section === 'skills'
      ? skills.items.length
      : section === 'mcp'
        ? mcp.items.length
        : section === 'knowledge'
          ? knowledge.items.length
          : teamSecrets.length + personalEnv.length

  const q = query.trim().toLowerCase()

  const skillRows = React.useMemo((): SkillRow[] => {
    if (section !== 'skills') return []
    return skills.items
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.slug.toLowerCase().includes(q) ||
          (s.summary?.toLowerCase().includes(q) ?? false),
      )
      .map((s) => {
        const metaParts: string[] = []
        if (s.kind === 'personal') {
          if (s.personalSourceLabel) metaParts.push(s.personalSourceLabel)
          if (s.category) metaParts.push(s.category)
        } else {
          if (s.category) metaParts.push(s.category)
          if (s.hasUpdate && s.installedVersion != null && s.latestVersion != null) {
            metaParts.push(`v${s.installedVersion} → v${s.latestVersion}`)
          } else if (s.latestVersion) metaParts.push(`v${s.latestVersion}`)
        }
        return {
          id: s.id,
          kind: s.kind,
          icon: Sparkles,
          iconTint: 'bg-coral/10 text-coral',
          title: s.name,
          subtitle: s.summary || undefined,
          meta: metaParts.filter(Boolean).join(' · ') || undefined,
          badge:
            s.status === 'deprecated' ? (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('teamShare.skillDeprecated', 'Deprecated')}
              </span>
            ) : undefined,
          dimmed: s.status === 'deprecated',
          // Three states, and only one of them is asking for anything.
          //
          // Behind on version is a transitional state that resolves itself
          // within a reconcile tick, so it stays as quiet as "installed" —
          // rendering it as an alert would train people to ignore alerts. A
          // local edit is different: auto-follow has stopped and will not
          // restart until a human decides, so it gets full ink in a column
          // where everything else is muted. That contrast is the emphasis;
          // coral is the brand accent, not a warning colour (AGENTS.md).
          trailing:
            s.kind === 'team-installed' ? (
              localState[s.slug]?.state === 'foreign' ? (
                <AlertTriangle
                  className="h-[15px] w-[15px] text-foreground"
                  aria-label={t(
                    'teamShare.skillForeign',
                    'A skill from another source already owns this name',
                  )}
                />
              ) : localState[s.slug]?.state === 'dirty' ? (
                <AlertTriangle
                  className="h-[15px] w-[15px] text-foreground"
                  aria-label={t('teamShare.skillConflict', 'Local changes — update paused')}
                />
              ) : s.hasUpdate ? (
                <ArrowUpCircle
                  className="h-[15px] w-[15px] text-muted-foreground"
                  aria-label={t('teamShare.skillUpdating', 'Updating…')}
                />
              ) : (
                <Check
                  className="h-[15px] w-[15px] text-muted-foreground"
                  aria-label={t('teamShare.skillInstalled', 'Installed')}
                />
              )
            ) : undefined,
        }
      })
  }, [section, q, skills.items, localState, t])

  const skillGroups = React.useMemo(() => {
    const available = skillRows.filter((r) => r.kind === 'team-available')
    const installed = skillRows.filter((r) => r.kind === 'team-installed')
    const personal = skillRows.filter((r) => r.kind === 'personal')
    return [
      {
        key: 'available' as const,
        label: t('teamShare.skillGroupAvailable', 'Team · Available'),
        rows: available,
      },
      {
        key: 'installed' as const,
        label: t('teamShare.skillGroupInstalled', 'Team · Installed'),
        rows: installed,
      },
      {
        key: 'personal' as const,
        label: t('teamShare.skillGroupPersonal', 'Personal'),
        rows: personal,
      },
    ].filter((g) => g.rows.length > 0 || !q)
  }, [skillRows, t, q])

  const otherRows = React.useMemo(() => {
    if (section === 'mcp') {
      return mcp.items
        .filter((m) => !q || m.name.toLowerCase().includes(q))
        .map((m) => {
          // An uninstalled server isn't wired up, so probe state is meaningless
          // for it — show what it is instead of a misleading "Idle".
          if (!m.installed) {
            return {
              id: m.name,
              icon: Plug,
              iconTint: 'bg-muted text-muted-foreground',
              title: m.name,
              subtitle:
                m.catalog?.description ||
                t('teamShare.mcpNotInstalledSubtitle', 'Available — install to run it here'),
              statusDot: 'idle' as const,
              dimmed: true,
            }
          }
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
            trailing: (
              <Check
                className="h-[15px] w-[15px] text-muted-foreground"
                aria-label={t('teamShare.mcpInstalled', 'Installed')}
              />
            ),
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
    if (section === 'env') {
      // Ids carry their scope. A personal key and a team key can share a name,
      // and the detail pane has to know which one it was handed.
      const team = teamSecrets
        .filter((e) => !q || e.keyId.toLowerCase().includes(q))
        .map((e) => {
          // decrypted === false means the value is there but this machine's team
          // key will not open it. Showing it as an ordinary row would be a lie.
          const undecryptable = e.decrypted === false
          return {
            id: `team:${e.keyId}`,
            icon: undecryptable ? AlertTriangle : e.category === 'config' ? Box : Lock,
            iconTint: undecryptable
              ? 'bg-amber-500/10 text-amber-600'
              : 'bg-muted text-muted-foreground',
            title: e.keyId,
            titleMono: true,
            subtitle: undecryptable
              ? e.keyMismatch
                ? t('teamShare.envDetail.keyMismatch', 'Team key does not match — cannot decrypt')
                : t('teamShare.envDetail.noLocalKey', 'No team key on this machine — cannot decrypt')
              : e.description || e.category || t('teamShare.envDetail.secret', 'Secret'),
            badge: undecryptable ? (
              <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-amber-600">
                {t('teamShare.envDetail.locked', 'Locked')}
              </span>
            ) : undefined,
          }
        })
      const personal = personalEnv
        .filter((e) => !q || e.key.toLowerCase().includes(q))
        .map((e) => ({
          id: `personal:${e.key}`,
          icon: Lock,
          iconTint: 'bg-muted text-muted-foreground',
          title: e.key,
          titleMono: true,
          subtitle: e.description || t('teamShare.envDetail.personalHint', 'Stays on this machine'),
        }))
      return [...team, ...personal]
    }
    return []
  }, [section, q, mcp.items, knowledge.items, teamSecrets, personalEnv, t])

  const installedCount = React.useMemo(
    () => skills.items.filter((s) => s.kind === 'team-installed').length,
    [skills.items],
  )
  /** Team and personal are different trust boundaries, so they get their own groups. */
  const envGroups = React.useMemo(() => {
    if (section !== 'env') return null
    const rows = otherRows as Array<{ id: string }>
    const team = rows.filter((r) => r.id.startsWith('team:'))
    const personal = rows.filter((r) => r.id.startsWith('personal:'))
    return [
      { key: 'team' as const, label: t('teamShare.scope.team', 'Team'), rows: team },
      { key: 'personal' as const, label: t('teamShare.scope.personal', 'Personal'), rows: personal },
    ].filter((g) => g.rows.length > 0 || !q)
  }, [section, otherRows, t, q])

  const mcpInstalledCount = React.useMemo(
    () => mcp.items.filter((m) => m.installed).length,
    [mcp.items],
  )
  const registryCount = React.useMemo(
    () => skills.items.filter((s) => s.kind !== 'personal').length,
    [skills.items],
  )

  // Creating at the root of the shared tree. FileTree's own create flow hangs
  // off a node's context menu, which an empty tree has none of — this is the
  // only way in when the team has no documents yet.
  async function handleRootCreate(name: string) {
    const trimmed = name.trim()
    setRootCreating(null)
    if (!trimmed || !knowledgeRoot) return
    const ok =
      rootCreating === 'folder'
        ? await createNewFolder(knowledgeRoot, trimmed)
        : await createNewFile(knowledgeRoot, trimmed)
    if (!ok) return
    await refreshFileTree()
    void loadSection('knowledge', { force: true })
    if (rootCreating !== 'folder') selectFile(`${knowledgeRoot}/${trimmed}`)
  }

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
            <span className="font-mono text-[11px] font-normal text-faint">
              {' '}
              ·{' '}
              {section === 'skills'
              ? `${installedCount}/${registryCount}`
              : section === 'mcp'
                ? `${mcpInstalledCount}/${mcp.items.length}`
                : count}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            disabled={refreshing}
            onClick={() => void handleRefresh()}
            title={t('common.refresh', 'Refresh')}
            data-testid="teamshare-refresh"
          >
            <RefreshCw className={cn('h-4 w-4', (refreshing || loading) && 'animate-spin')} />
          </Button>
          {syncAvailable && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              disabled={syncing}
              onClick={() => void syncNow()}
              title={t('teamShare.cloudSync', 'Cloud sync')}
              data-testid="teamshare-cloud-sync"
            >
              {syncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Cloud className="h-4 w-4" />
              )}
            </Button>
          )}
          {section === 'knowledge' && !needsEnabling && knowledgeRoot && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  title={t('teamShare.knowledgeAdd', 'New document or folder')}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onSelect={() => setRootCreating('file')}>
                  <FilePlus className="mr-2 h-3.5 w-3.5" />
                  {t('teamShare.knowledgeNewFile', 'New document')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setRootCreating('folder')}>
                  <FolderPlus className="mr-2 h-3.5 w-3.5" />
                  {t('teamShare.knowledgeNewFolder', 'New folder')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {(section === 'mcp' || section === 'env') && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setCreating(section)}
              title={
                section === 'mcp'
                  ? t('teamShare.mcpAdd', 'Add MCP server')
                  : t('teamShare.envAdd', 'Add team env key')
              }
            >
              <Plus className="h-4 w-4" />
            </Button>
          )}
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
        {loading && count === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : section === 'skills' ? (
          skillRows.length === 0 ? (
            <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
              {t(
                'teamShare.skillsEmptyUnified',
                'No team or personal skills yet. Add a skill folder on disk, or wait for a teammate to publish.',
              )}
            </div>
          ) : (
            skillGroups.map((group) => (
              <div key={group.key}>
                <GroupHeader label={group.label} count={group.rows.length} />
                {group.rows.length === 0 ? (
                  <div className="px-4 pb-2 text-[11.5px] text-faint">
                    {t('teamShare.skillGroupEmpty', 'None')}
                  </div>
                ) : (
                  group.rows.map((row) => (
                    <ItemRow
                      key={`${row.kind}-${row.id}`}
                      active={selected === row.id}
                      icon={row.icon}
                      iconTint={row.iconTint}
                      title={row.title}
                      subtitle={row.subtitle}
                      meta={row.meta}
                      badge={row.badge}
                      trailing={row.trailing}
                      dimmed={row.dimmed}
                      onClick={() => select(section, row.id)}
                    />
                  ))
                )}
              </div>
            ))
          )
        ) : section === 'knowledge' ? (
          needsEnabling ? (
            // Not enabled for this team yet — onboarding belongs here, where
            // the empty column is the problem it solves.
            <KnowledgeEnablePanel />
          ) : knowledgeRoot ? (
            // The whole shared root, not just knowledge/ — create / rename /
            // delete / move all come from FileBrowser's existing context menu,
            // and clicking a file opens it exactly as it does in the workspace.
            <FileBrowser
              variant="panel"
              rootPath={knowledgeRoot}
              hideGitStatus={false}
              hideToolbar
              filterText={query}
              onFilterTextChange={setQuery}
              rootCreating={rootCreating}
              onRootCreateCancel={() => setRootCreating(null)}
              onRootCreateConfirm={(name) => {
                void handleRootCreate(name)
              }}
            />
          ) : (
            <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
              {t(
                'teamShare.knowledgeNoRoot',
                'Team shared folder is not set up on this machine yet.',
              )}
            </div>
          )
        ) : envGroups ? (
          envGroups.every((g) => g.rows.length === 0) ? (
            <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
              {t('teamShare.envEmpty', 'No environment variables yet.')}
            </div>
          ) : (
            envGroups.map((group) => (
              <div key={group.key}>
                <GroupHeader label={group.label} count={group.rows.length} />
                {group.rows.length === 0 ? (
                  <div className="px-4 pb-2 text-[11.5px] text-faint">
                    {t('teamShare.skillGroupEmpty', 'None')}
                  </div>
                ) : (
                  (group.rows as typeof otherRows).map((row) => (
                    <ItemRow
                      key={row.id}
                      active={selected === row.id}
                      icon={row.icon}
                      iconTint={row.iconTint}
                      title={row.title}
                      titleMono={'titleMono' in row ? Boolean(row.titleMono) : false}
                      subtitle={row.subtitle}
                      badge={'badge' in row ? (row.badge as React.ReactNode) : undefined}
                      onClick={() => select(section, row.id)}
                    />
                  ))
                )}
              </div>
            ))
          )
        ) : otherRows.length === 0 ? (
          <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
            {t('teamShare.empty', 'Nothing shared with the team yet.')}
          </div>
        ) : (
          otherRows.map((row) => (
            <ItemRow
              key={row.id}
              active={selected === row.id}
              icon={row.icon}
              iconTint={row.iconTint}
              title={row.title}
              titleMono={'titleMono' in row ? Boolean(row.titleMono) : false}
              subtitle={row.subtitle}
              statusDot={
                'statusDot' in row
                  ? (row.statusDot as 'ready' | 'failed' | 'idle' | undefined)
                  : undefined
              }
              trailing={'trailing' in row ? (row.trailing as React.ReactNode) : undefined}
              dimmed={'dimmed' in row ? Boolean(row.dimmed) : false}
              onClick={() => select(section, row.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}
