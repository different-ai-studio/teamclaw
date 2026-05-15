import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Search, SquarePen, Loader2, MessageSquare, Pin, Archive, Pencil, Ellipsis } from 'lucide-react'
import { useSessionStore } from '@/stores/session'
import { useStreamingStore } from '@/stores/streaming'
import { useUIStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCronStore } from '@/stores/cron'
import { useSessionListStore, type SessionListEntry } from '@/stores/session-list-store'
import { useSidebar } from '@/components/ui/sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { AnimatedClock } from '@/components/ui/animated-clock'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SessionSearchDialog } from '@/components/sidebar/session-search-dialog'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/date-format'
import { buildSessionListActivityMap, type SessionListActivity } from '@/lib/session-list-activity'
import { loadSessionIdsForActor } from '@/lib/session-by-actor'
import {
  loadSessionParticipants,
  loadActorsByIds,
} from '@/lib/local-cache'
import { actorAvatarColor } from '@/lib/actor-color'

/**
 * Merged row shape consumed by the rendering pipeline. Combines list-canonical
 * fields from `useSessionListStore.rows` (title, last_message_*, idea_id) with
 * per-user state (pin) we need for sorting.
 */
type ListRow = {
  id: string
  title: string
  teamId: string
  lastMessageAt: Date | null
  lastMessagePreview: string | null
  ideaId: string | null
  isPinned: boolean
}

type ParticipantInfo = {
  actorId: string
  displayName: string
  avatarUrl: string | null
  isAgent: boolean
}

function entryToRow(entry: SessionListEntry, isPinned: boolean): ListRow {
  return {
    id: entry.id,
    title: entry.title,
    teamId: entry.team_id,
    lastMessageAt: entry.last_message_at ? new Date(entry.last_message_at) : null,
    lastMessagePreview: entry.last_message_preview,
    ideaId: entry.idea_id,
    isPinned,
  }
}

function SessionActivityBadge({ activity }: { activity?: SessionListActivity }) {
  const { t } = useTranslation()
  if (!activity) return null
  if (activity.state === 'running') {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-label={t('sidebar.sessionRunning', 'Running')} />
  }
  return (
    <span className="min-w-0 shrink rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold leading-4 text-emerald-600">
      <span className="block truncate">{t('sidebar.awaitingConfirmation', 'Awaiting confirmation')}</span>
    </span>
  )
}

function SessionRenameInput({ defaultValue, onConfirm, onCancel }: {
  defaultValue: string
  onConfirm: (v: string) => void
  onCancel: () => void
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => { ref.current?.focus(); ref.current?.select() }, [defaultValue])
  return (
    <input
      ref={ref}
      defaultValue={defaultValue}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const v = ref.current?.value.trim()
          if (v) onConfirm(v); else onCancel()
        } else if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => {
        const v = ref.current?.value.trim()
        if (v) onConfirm(v); else onCancel()
      }}
      onClick={(e) => e.stopPropagation()}
      className="flex-1 bg-transparent border border-primary/50 rounded px-1.5 py-0.5 text-sm outline-none focus:border-primary min-w-0"
    />
  )
}

export function SessionListColumn() {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)

  // List source: v2 canonical store. Entries already carry last_message_at,
  // last_message_preview, idea_id — no extra Supabase round-trip needed.
  const listRows = useSessionListStore((s) => s.rows)
  const listLoading = useSessionListStore((s) => s.loading)

  // Per-user state (pin, active row, highlight, activity badges) stays on the
  // legacy useSessionStore. Reads here are read-only; writes (rename / archive
  // / pin) go through its handlers, which update both stores transitively.
  const allSessions = useSessionStore((s) => s.sessions)
  const pinnedSessionIds = useSessionStore((s) => s.pinnedSessionIds)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const highlightedSessionIds = useSessionStore((s) => s.highlightedSessionIds)
  const sessionStatuses = useSessionStore((s) => s.sessionStatuses) || {}
  const pendingQuestionIdsBySession = useSessionStore((s) => s.pendingQuestionIdsBySession) || {}
  const pendingQuestions = useSessionStore((s) => s.pendingQuestions) || []
  const pendingPermissions = useSessionStore((s) => s.pendingPermissions) || []
  const streamingMessageId = useStreamingStore((s) => s.streamingMessageId)
  const childSessionStreaming = useStreamingStore((s) => s.childSessionStreaming)
  const archiveSession = useSessionStore((s) => s.archiveSession)
  const updateSessionTitle = useSessionStore((s) => s.updateSessionTitle)
  const toggleSessionPinned = useSessionStore((s) => s.toggleSessionPinned)
  const cronSessionIds = useCronStore((s) => s.cronSessionIds)
  const showCronSessions = useCronStore((s) => s.showCronSessions)
  const toggleShowCronSessions = useCronStore((s) => s.toggleShowCronSessions)

  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const hasWorkspace = !!workspacePath
  const { state: sidebarState } = useSidebar()
  const sidebarCollapsed = sidebarState === 'collapsed'

  const [searchOpen, setSearchOpen] = React.useState(false)
  const [renamingSessionId, setRenamingSessionId] = React.useState<string | null>(null)
  const [actorSessionIds, setActorSessionIds] = React.useState<Set<string> | null>(null)
  const [actorLoading, setActorLoading] = React.useState(false)
  /**
   * Per-session participant cache. Populated lazily once a row becomes visible
   * (see the visibleIds effect below). Each entry is the joined result of
   * session_participant × actor from libsql, so we hit local cache only.
   *
   * Not invalidated on participant change today — would need to wire into the
   * realtime envelope handler in App.tsx if that becomes important. Tracked in
   * AGENTS.md §7.
   */
  const [participantsBySession, setParticipantsBySession] = React.useState<
    Record<string, ParticipantInfo[]>
  >({})

  // Load actor-session set when filter switches to actor mode.
  // teamId is only used for cache namespacing; the supabase query is by actor_id.
  const teamIdFromList = useSessionListStore((s) => s.rows[0]?.team_id ?? '')
  React.useEffect(() => {
    if (filter.kind !== 'actor') {
      setActorSessionIds(null)
      return
    }
    let cancelled = false
    setActorLoading(true)
    void loadSessionIdsForActor(filter.actorId, teamIdFromList).then((ids) => {
      if (!cancelled) {
        setActorSessionIds(ids)
        setActorLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [filter, teamIdFromList])

  // ⌘K opens search
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (hasWorkspace) setSearchOpen((o) => !o)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [hasWorkspace])

  /**
   * Apply cron / pin / idea / actor filters and sort: pinned first within
   * each filter mode, then last_message_at DESC. Rows with null
   * last_message_at (brand-new sessions) sort to the top, matching the
   * convention in `session-list-store.sortEntries`.
   */
  const filteredRows = React.useMemo<ListRow[]>(() => {
    const pinnedSet = new Set(pinnedSessionIds)
    let base = listRows.map((r) => entryToRow(r, pinnedSet.has(r.id)))

    base = base.filter((r) =>
      showCronSessions ? cronSessionIds.has(r.id) : !cronSessionIds.has(r.id),
    )

    if (filter.kind === 'pinned') {
      base = base.filter((r) => r.isPinned)
    } else if (filter.kind === 'idea') {
      base = base.filter((r) => r.ideaId === filter.ideaId)
    } else if (filter.kind === 'actor') {
      if (!actorSessionIds) return []
      base = base.filter((r) => actorSessionIds.has(r.id))
    }

    return base.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
      if (!a.lastMessageAt && !b.lastMessageAt) return 0
      if (!a.lastMessageAt) return -1
      if (!b.lastMessageAt) return 1
      return b.lastMessageAt.getTime() - a.lastMessageAt.getTime()
    })
  }, [listRows, pinnedSessionIds, cronSessionIds, showCronSessions, filter, actorSessionIds])

  /**
   * Load participants for any visible row we haven't seen yet. Two libsql
   * round-trips per session: session_participant by sessionId, then actor by
   * id batch. Both tables are indexed for these queries.
   */
  const visibleIds = filteredRows.map((r) => r.id).join('|')
  React.useEffect(() => {
    if (filteredRows.length === 0) return
    const missing = filteredRows
      .map((r) => r.id)
      .filter((id) => !participantsBySession[id])
    if (missing.length === 0) return
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        missing.map(async (sid) => {
          const parts = await loadSessionParticipants(sid)
          if (parts.length === 0) return [sid, [] as ParticipantInfo[]] as const
          const actorIds = parts.map((p) => p.actorId)
          const actors = await loadActorsByIds(actorIds)
          const byId = new Map(actors.map((a) => [a.id, a] as const))
          const info: ParticipantInfo[] = parts
            .map((p) => {
              const a = byId.get(p.actorId)
              if (!a) return null
              return {
                actorId: a.id,
                displayName: a.displayName,
                avatarUrl: a.avatarUrl ?? null,
                isAgent: a.actorType === 'agent',
              }
            })
            .filter((x): x is ParticipantInfo => x !== null)
          return [sid, info] as const
        }),
      )
      if (cancelled) return
      setParticipantsBySession((prev) => {
        const next = { ...prev }
        for (const [sid, info] of entries) next[sid] = info
        return next
      })
    })()
    return () => { cancelled = true }
    // visibleIds (string) carries the row id set; including participantsBySession would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIds])

  /**
   * Date-bucket rows (Today / Yesterday / This week / Earlier). Rows without
   * a last_message_at — brand new sessions — fall into Today so they're
   * immediately visible at the top.
   */
  const groupedRows = React.useMemo(() => {
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const startOfYesterday = startOfToday - 86400_000
    const startOfWeek = startOfToday - 6 * 86400_000
    const groups: { key: string; label: string; items: ListRow[] }[] = [
      { key: 'today',     label: t('sidebar.dateToday', 'Today'),         items: [] },
      { key: 'yesterday', label: t('sidebar.dateYesterday', 'Yesterday'), items: [] },
      { key: 'thisWeek',  label: t('sidebar.dateThisWeek', 'This week'),  items: [] },
      { key: 'earlier',   label: t('sidebar.dateEarlier', 'Earlier'),     items: [] },
    ]
    for (const r of filteredRows) {
      const ts = r.lastMessageAt?.getTime() ?? Number.POSITIVE_INFINITY
      if (ts >= startOfToday) groups[0].items.push(r)
      else if (ts >= startOfYesterday) groups[1].items.push(r)
      else if (ts >= startOfWeek) groups[2].items.push(r)
      else groups[3].items.push(r)
    }
    return groups.filter((g) => g.items.length > 0)
  }, [filteredRows, t])

  const sessionActivityMap = React.useMemo(
    () =>
      buildSessionListActivityMap({
        sessions: allSessions,
        activeSessionId,
        sessionStatuses,
        pendingQuestionIdsBySession,
        pendingQuestions,
        pendingPermissions,
        streamingMessageId,
        streamingChildSessionIds: Object.values(childSessionStreaming)
          .filter((state) => state?.isStreaming)
          .map((state) => state.sessionId),
      }),
    [
      activeSessionId,
      allSessions,
      childSessionStreaming,
      pendingPermissions,
      pendingQuestionIdsBySession,
      pendingQuestions,
      sessionStatuses,
      streamingMessageId,
    ],
  )

  const title = (() => {
    if (filter.kind === 'all') return t('sidebar.sessions', 'Sessions')
    if (filter.kind === 'pinned') return t('sidebar.pinned', 'Pinned')
    if (filter.kind === 'idea') return filter.title
    if (filter.kind === 'actor') return filter.displayName
    return ''
  })()

  const handleNewChat = () => {
    if (!hasWorkspace) return
    if (filter.kind === 'actor') {
      useUIStore.getState().enterActorDraft({
        id: filter.actorId,
        displayName: filter.displayName,
        kind: filter.actorType,
      })
      return
    }
    useUIStore.getState().startNewChat()
    if (filter.kind === 'idea') {
      useUIStore.getState().setDraftIdeaId(filter.ideaId)
    }
  }

  const handleSelectSession = (id: string) => useUIStore.getState().switchToSession(id)
  const handleStartRename = (e: React.SyntheticEvent, id: string) => { e.stopPropagation(); setRenamingSessionId(id) }
  const handleRenameConfirm = async (id: string, newTitle: string) => {
    const current = listRows.find((r) => r.id === id)?.title
    if (newTitle.trim() && newTitle !== current) {
      try { await updateSessionTitle(id, newTitle.trim()) }
      catch (e) { console.error('[SessionListColumn] rename failed:', e) }
    }
    setRenamingSessionId(null)
  }
  const handleArchive = async (e: React.SyntheticEvent, id: string) => { e.stopPropagation(); await archiveSession(id) }
  const handleTogglePinned = (e: React.SyntheticEvent, id: string) => { e.stopPropagation(); toggleSessionPinned(id) }

  const renderSessionItem = (row: ListRow) => {
    const isHighlighted = highlightedSessionIds.includes(row.id)
    const isRenaming = renamingSessionId === row.id
    const isActive = row.id === activeSessionId
    const activity = sessionActivityMap.get(row.id)
    const parts = participantsBySession[row.id] ?? []
    return (
      <SidebarMenuItem key={row.id}>
        <SidebarMenuButton
          isActive={isActive}
          className={cn(
            // Direction B: paper-on-paper active state, 2px coral left bar.
            // See AGENTS.md §2 "Session list".
            'h-auto rounded-none py-3 pl-4 pr-4 transition-colors',
            isActive &&
              "relative z-0 data-[active=true]:!bg-paper data-[active=true]:font-medium before:pointer-events-none before:absolute before:left-0 before:top-0 before:bottom-0 before:z-10 before:w-[2px] before:bg-coral before:content-['']",
            isHighlighted && !isActive && 'bg-emerald-500/15 ring-1 ring-emerald-500/30',
          )}
          onClick={() => { if (!isRenaming) handleSelectSession(row.id) }}
          onDoubleClick={(e) => { e.stopPropagation(); handleStartRename(e, row.id) }}
        >
          <div className="flex flex-col items-start gap-1.5 flex-1 min-w-0">
            {/* Title row: [pin] title [time] [NEW] */}
            <div className="flex items-center gap-1.5 w-full">
              {row.isPinned && <Pin className="h-3 w-3 shrink-0 text-amber-500 fill-amber-500/20" />}
              {isRenaming ? (
                <SessionRenameInput
                  defaultValue={row.title}
                  onConfirm={(v) => handleRenameConfirm(row.id, v)}
                  onCancel={() => setRenamingSessionId(null)}
                />
              ) : (
                <>
                  <span className={cn(
                    'min-w-0 flex-1 truncate text-left text-[13px]',
                    isActive ? 'font-semibold text-foreground' : 'font-medium text-foreground',
                  )}>
                    {row.title || t('chat.newChat', 'New Chat')}
                  </span>
                  {row.lastMessageAt && (
                    <span className="shrink-0 font-mono text-[10.5px] text-faint">
                      {formatRelativeTime(row.lastMessageAt)}
                    </span>
                  )}
                  {!isActive && isHighlighted && (
                    <span className="shrink-0 rounded-full bg-coral px-1.5 py-px text-[10px] font-semibold leading-4 text-white">
                      {t('chat.newSessionBadge', 'NEW')}
                    </span>
                  )}
                </>
              )}
            </div>
            {/* Preview line: 2 lines max from last_message_preview. AGENTS.md §2. */}
            {!isRenaming && row.lastMessagePreview && (
              <div className="w-full text-[12px] leading-[1.45] text-muted-foreground overflow-hidden text-ellipsis [display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical]">
                {row.lastMessagePreview}
              </div>
            )}
            {/* Participants cluster + activity badge */}
            {!isRenaming && (parts.length > 0 || activity) && (
              <div className="flex w-full items-center gap-1.5">
                {parts.length > 0 && (
                  <>
                    <div className="flex -space-x-1.5">
                      {parts.slice(0, 3).map((p) => {
                        const c = actorAvatarColor(p.actorId)
                        return (
                          <Avatar
                            key={p.actorId}
                            className={cn(
                              'h-4 w-4 ring-1 ring-paper',
                              p.isAgent ? 'rounded-[3px]' : 'rounded-full',
                            )}
                          >
                            {p.avatarUrl && <AvatarImage src={p.avatarUrl} alt={p.displayName} />}
                            <AvatarFallback
                              className={cn(
                                'text-[8px] font-semibold',
                                p.isAgent ? 'rounded-[3px]' : 'rounded-full',
                              )}
                              style={{ background: c.bg, color: c.fg }}
                            >
                              {p.displayName.slice(0, 1).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                        )
                      })}
                    </div>
                    <span className="text-[10.5px] text-faint">
                      {t('sidebar.participantCount', { count: parts.length, defaultValue: '{{count}} 位' })}
                    </span>
                  </>
                )}
                <span className="flex-1" />
                <SessionActivityBadge activity={activity} />
              </div>
            )}
          </div>
        </SidebarMenuButton>
        {/* Direction B: ellipsis menu sits on row 3 (avatars row), right-aligned.
            Avoids overlapping title & preview text. AGENTS.md §2. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 bottom-2 h-6 w-6 opacity-0 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 transition-opacity hover:bg-black/10 dark:hover:bg-white/10 rounded-md"
              onClick={(e) => e.stopPropagation()}
            >
              <Ellipsis className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="text-[13px]"
              onClick={(e) => handleTogglePinned(e as React.SyntheticEvent, row.id)}
            >
              <Pin className="h-3.5 w-3.5 mr-2" />
              {row.isPinned ? t('sidebar.unpin', 'Unpin') : t('sidebar.pinToTop', 'Pin to top')}
            </DropdownMenuItem>
            <DropdownMenuItem className="text-[13px]" onClick={(e) => handleStartRename(e, row.id)}>
              <Pencil className="h-3.5 w-3.5 mr-2" />
              {t('sidebar.rename', 'Rename')}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-[13px]"
              onClick={(e) => handleArchive(e as React.SyntheticEvent, row.id)}
            >
              <Archive className="h-3.5 w-3.5 mr-2" />
              {t('sidebar.archive', 'Archive')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    )
  }

  return (
    <div className="flex h-full flex-col min-w-0 border-r border-border bg-background">
      <SessionSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />

      <div
        className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border"
        data-tauri-drag-region
      >
        {sidebarCollapsed && (
          <div className="flex items-center gap-1 shrink-0">
            <TrafficLights />
            <SidebarCollapseToggle />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-bold tracking-tight text-foreground">
            {title}{' '}
            <span className="font-mono text-[11px] font-normal text-faint">
              · {filteredRows.length}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-40"
            disabled={!hasWorkspace}
            onClick={handleNewChat}
            title={t('chat.newChat', 'New Chat')}
          >
            <SquarePen className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-40"
            disabled={!hasWorkspace}
            onClick={() => setSearchOpen(true)}
            title={t('sidebar.searchWithShortcut', 'Search (⌘K)')}
          >
            <Search className="h-4 w-4" />
          </Button>
          {filter.kind === 'all' && (
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-7 w-7 transition-colors disabled:opacity-40',
                showCronSessions ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground',
              )}
              disabled={!hasWorkspace}
              onClick={toggleShowCronSessions}
              title={showCronSessions ? t('sidebar.showAllSessions', 'Show all sessions') : t('sidebar.showCronSessions', 'Show scheduled sessions')}
            >
              <AnimatedClock className="h-4 w-4" animate={showCronSessions} />
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {filter.kind === 'actor' && actorLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : listLoading && filteredRows.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <MessageSquare className="h-8 w-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">{t('sidebar.noConversations', 'No conversations')}</p>
          </div>
        ) : (
          <SidebarMenu>
            {groupedRows.map((group) => (
              <React.Fragment key={group.key}>
                <div className="px-4 pt-3 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                  {group.label}{' '}
                  <span className="font-mono text-faint/80">· {group.items.length}</span>
                </div>
                {group.items.map(renderSessionItem)}
              </React.Fragment>
            ))}
          </SidebarMenu>
        )}
        {/* Load-more deferred — useSessionListStore caps at 50; pagination
            lands in a separate pass (see AGENTS.md §7). */}
      </div>
    </div>
  )
}
