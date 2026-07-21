import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, Loader2, MessageSquare, Pin, Archive, Pencil, Ellipsis, Info, SquarePen, Users, X } from 'lucide-react'
import { useSessionStore } from '@/stores/session'
import { useStreamingStore } from '@/stores/streaming'
import { useUIStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCronStore } from '@/stores/cron'
import { useSessionListStore, type SessionListEntry } from '@/stores/session-list-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionParticipantStore } from '@/stores/session-participant-store'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { createQuickSession, describeQuickSessionFailure } from '@/lib/create-quick-session'
import { toast } from 'sonner'
import { useSidebarSafe } from '@/components/ui/sidebar'
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
import { SessionDetailDialog, type SessionDetailListHints } from '@/components/sidebar/SessionDetailDialog'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/date-format'
import { useTypeAhead } from '@/hooks/use-type-ahead'
import { buildSessionListActivityMap, type SessionListActivity } from '@/lib/session-list-activity'
import { loadSessionIdsForActor } from '@/lib/session-by-actor'
import { loadSessionIdsForWorkspace } from '@/lib/session-by-workspace'
import { actorAvatarColor } from '@/lib/actor-color'
import { useSessionWorkspaceLabels } from '@/hooks/use-session-workspace-labels'
import { compareSessionListByRecency } from '@/lib/session-list-sort'

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
  createdAt: Date | null
  lastMessagePreview: string | null
  ideaId: string | null
  isPinned: boolean
  hasUnread: boolean
}

function entryToRow(entry: SessionListEntry, isPinned: boolean): ListRow {
  return {
    id: entry.id,
    title: entry.title,
    teamId: entry.team_id,
    lastMessageAt: entry.last_message_at ? new Date(entry.last_message_at) : null,
    createdAt: entry.created_at ? new Date(entry.created_at) : null,
    lastMessagePreview: entry.last_message_preview,
    ideaId: entry.idea_id,
    isPinned,
    hasUnread: entry.has_unread,
  }
}

/**
 * Below this many rows we render the plain (non-virtualized) list so short
 * lists keep identical DOM/behavior (and unit tests, which render a handful of
 * rows, exercise the unchanged path). Above it we switch to a windowed list to
 * avoid mounting hundreds of session rows at once.
 */
const VIRTUAL_SESSION_THRESHOLD = 40

/** Tighter header padding and title when the column is very narrow. */
const COMPACT_HEADER_MAX_WIDTH = 360

function useCompactColumnHeader(threshold = COMPACT_HEADER_MAX_WIDTH) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [compact, setCompact] = React.useState(false)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return

    const sync = (width: number) => {
      if (width <= 0) return
      setCompact(width < threshold)
    }
    sync(el.getBoundingClientRect().width)

    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => {
      sync(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [threshold])

  return { ref, compact }
}

/** Flattened item consumed by the virtualizer (header / divider / session). */
type VirtualRow =
  | { key: string; kind: 'pinned-header' }
  | { key: string; kind: 'divider' }
  | { key: string; kind: 'session'; row: ListRow }

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

export function SessionListColumn({
  showNewSessionActions,
  onDismiss,
}: {
  showNewSessionActions?: boolean
  /** When embedded in a sheet/modal, render an inline close control in the header. */
  onDismiss?: () => void
} = {}) {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)
  const embedMode = useUIStore((s) => s.embedMode)

  // List source: v2 canonical store. Entries already carry last_message_at,
  // last_message_preview, idea_id — no extra Supabase round-trip needed.
  const listRows = useSessionListStore((s) => s.rows)
  const listLoading = useSessionListStore((s) => s.loading)
  const listHasMore = useSessionListStore((s) => s.hasMore)
  const loadMoreSessions = useSessionListStore((s) => s.loadMore)

  // Activity badges still read legacy compat state until the activity store is
  // extracted. List actions and row state are v2-owned.
  const allSessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionSelectionStore((s) => s.activeSessionId)
  const pinnedSessionIds = useSessionListStore((s) => s.pinnedSessionIds)
  const highlightedSessionIds = useSessionListStore((s) => s.highlightedSessionIds)
  const sessionStatuses = useSessionStore((s) => s.sessionStatuses) || {}
  const pendingQuestionIdsBySession = useSessionStore((s) => s.pendingQuestionIdsBySession) || {}
  const pendingQuestions = useSessionStore((s) => s.pendingQuestions) || []
  const pendingPermissions = useSessionStore((s) => s.pendingPermissions) || []
  const streamingMessageId = useStreamingStore((s) => s.streamingMessageId)
  const childSessionStreaming = useStreamingStore((s) => s.childSessionStreaming)
  const archiveSession = useSessionStore((s) => s.archiveSession)
  const updateSessionTitle = useSessionListStore((s) => s.updateSessionTitle)
  const toggleSessionPinned = useSessionListStore((s) => s.toggleSessionPinned)
  const initPinnedSessionIds = useSessionListStore((s) => s.initPinnedSessionIds)
  const cronSessionIds = useCronStore((s) => s.cronSessionIds)
  const showCronSessions = useCronStore((s) => s.showCronSessions)
  const toggleShowCronSessions = useCronStore((s) => s.toggleShowCronSessions)

  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const hasWorkspace = !!workspacePath
  const sessionHeaderActionsEnabled = hasWorkspace || embedMode
  const { state: sidebarState } = useSidebarSafe()
  const sidebarCollapsed = sidebarState === 'collapsed'
  const { ref: columnRef, compact: compactHeader } = useCompactColumnHeader()

  const [searchOpen, setSearchOpen] = React.useState(false)
  const [creatingSession, setCreatingSession] = React.useState(false)
  const [renamingSessionId, setRenamingSessionId] = React.useState<string | null>(null)
  const [detailSessionId, setDetailSessionId] = React.useState<string | null>(null)
  const [detailHints, setDetailHints] = React.useState<SessionDetailListHints | null>(null)
  const [actorSessionIds, setActorSessionIds] = React.useState<Set<string> | null>(null)
  const [actorLoading, setActorLoading] = React.useState(false)
  const participantsBySession = useSessionParticipantStore((s) => s.participantsBySession)
  const ensureParticipants = useSessionParticipantStore((s) => s.ensureParticipants)

  // Load actor-session set when filter switches to actor mode.
  // teamId is only used for cache namespacing; the supabase query is by actor_id.
  const teamIdFromList = useCurrentTeamStore((s) => s.team?.id ?? '')
  const sessionWorkspaceLabels = useSessionWorkspaceLabels(teamIdFromList || null)
  React.useEffect(() => {
    initPinnedSessionIds(teamIdFromList || null)
  }, [initPinnedSessionIds, teamIdFromList])
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

  // Load workspace-session set when filter switches to workspace mode.
  // Reads the LOCAL libsql cache only — no cloud round-trip.
  const [workspaceSessionIds, setWorkspaceSessionIds] = React.useState<Set<string> | null>(null)
  React.useEffect(() => {
    if (filter.kind !== 'workspace') {
      setWorkspaceSessionIds(null)
      return
    }
    let cancelled = false
    void loadSessionIdsForWorkspace(teamIdFromList, { workspaceId: filter.workspaceId, path: filter.path })
      .then((ids) => { if (!cancelled) setWorkspaceSessionIds(ids) })
    return () => { cancelled = true }
  }, [filter, teamIdFromList])

  // ⌘K opens search
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (sessionHeaderActionsEnabled) setSearchOpen((o) => !o)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [sessionHeaderActionsEnabled])

  /**
   * Apply cron / pin / idea / actor filters and sort by last_message_at DESC.
   * Pinned vs unpinned split happens at render time for the "all" filter.
   */
  const filteredRows = React.useMemo<ListRow[]>(() => {
    const pinnedSet = new Set(pinnedSessionIds)
    let base = listRows.map((r) => entryToRow(r, pinnedSet.has(r.id)))
    const isClockView = filter.kind === 'all' && showCronSessions

    base = base.filter((r) =>
      isClockView ? cronSessionIds.has(r.id) : !cronSessionIds.has(r.id),
    )

    if (filter.kind === 'pinned') {
      base = base.filter((r) => r.isPinned)
    } else if (filter.kind === 'idea') {
      base = base.filter((r) => r.ideaId === filter.ideaId)
    } else if (filter.kind === 'actor') {
      if (!actorSessionIds) return []
      base = base.filter((r) => actorSessionIds.has(r.id))
    } else if (filter.kind === 'workspace') {
      if (!workspaceSessionIds) return []
      base = base.filter((r) => workspaceSessionIds.has(r.id))
    }

    return base.sort(compareSessionListByRecency)
  }, [listRows, pinnedSessionIds, cronSessionIds, showCronSessions, filter, actorSessionIds, workspaceSessionIds])

  const { pinnedRows, regularRows } = React.useMemo(() => {
    if (filter.kind !== 'all') {
      return { pinnedRows: [] as ListRow[], regularRows: filteredRows }
    }
    return {
      pinnedRows: filteredRows.filter((r) => r.isPinned),
      regularRows: filteredRows.filter((r) => !r.isPinned),
    }
  }, [filteredRows, filter.kind])

  // Flatten the pinned-header / pinned rows / divider / regular rows into a
  // single sequence so the virtualizer can window over one index space. Mirrors
  // exactly what the non-virtual JSX renders below.
  const virtualRows = React.useMemo<VirtualRow[]>(() => {
    const items: VirtualRow[] = []
    if (filter.kind === 'all' && pinnedRows.length > 0) {
      items.push({ key: '__pinned-header', kind: 'pinned-header' })
      for (const row of pinnedRows) items.push({ key: row.id, kind: 'session', row })
      if (regularRows.length > 0) items.push({ key: '__pinned-divider', kind: 'divider' })
    }
    const tail = filter.kind === 'all' ? regularRows : filteredRows
    for (const row of tail) items.push({ key: row.id, kind: 'session', row })
    return items
  }, [filter.kind, pinnedRows, regularRows, filteredRows])

  const shouldVirtualize = virtualRows.length > VIRTUAL_SESSION_THRESHOLD
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const sessionVirtualizer = useVirtualizer({
    count: shouldVirtualize ? virtualRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
    gap: 4,
    getItemKey: (index) => virtualRows[index].key,
  })

  /** Load participants for any visible row we haven't seen yet. */
  const visibleIds = filteredRows.map((r) => r.id).join('|')
  React.useEffect(() => {
    if (filteredRows.length === 0) return
    void ensureParticipants(filteredRows.map((r) => r.id))
  }, [ensureParticipants, filteredRows, visibleIds])

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
    if (filter.kind === 'all') {
      return showCronSessions
        ? t('sidebar.scheduledSessions', 'Scheduled sessions')
        : t('sidebar.sessions', 'Sessions')
    }
    if (filter.kind === 'pinned') return t('sidebar.pinned', 'Pinned')
    if (filter.kind === 'idea') return filter.title
    if (filter.kind === 'actor') return filter.displayName
    if (filter.kind === 'workspace') return filter.name
    return ''
  })()

  const handleSelectSession = (id: string) => useUIStore.getState().switchToSession(id)

  const showNewChatButton = embedMode || (showNewSessionActions && !compactHeader)

  const handleNewChatClick = React.useCallback(() => {
    if (embedMode) {
      if (creatingSession) return
      setCreatingSession(true)
      void createQuickSession()
        .then((result) => {
          if (result.ok) {
            onDismiss?.()
            return
          }
          const { title, description } = describeQuickSessionFailure(result.reason, t)
          toast.error(title, {
            description,
            ...(result.reason === 'no_agent'
              ? {
                  action: {
                    label: t('chat.quickSessionSetDefaultAgent', 'Set default agent'),
                    onClick: () => useUIStore.getState().openSettings('daemonGeneral'),
                  },
                }
              : {}),
          })
        })
        .catch((e) => {
          console.error('[SessionListColumn] quick create failed', e)
          const { title, description } = describeQuickSessionFailure('server_error', t)
          toast.error(title, { description })
        })
        .finally(() => setCreatingSession(false))
      return
    }
    useUIStore.getState().startNewChat()
  }, [creatingSession, embedMode, onDismiss, t])

  // Native list type-ahead: with no input focused, typing letters / digits /
  // CJK jumps to the first session whose title starts with the buffer.
  const typeAheadItems = React.useMemo(
    () => filteredRows.map((r) => ({ id: r.id, label: r.title })),
    [filteredRows],
  )
  useTypeAhead({
    enabled: filteredRows.length > 0,
    items: typeAheadItems,
    onMatch: handleSelectSession,
  })

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
  const handleTogglePinned = (e: React.SyntheticEvent, id: string) => {
    e.stopPropagation()
    toggleSessionPinned(id, teamIdFromList || null)
  }
  const handleViewDetail = (e: React.SyntheticEvent, row: ListRow) => {
    e.stopPropagation()
    setDetailHints({
      title: row.title,
      ideaId: row.ideaId,
      isPinned: row.isPinned,
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
      lastMessagePreview: row.lastMessagePreview,
    })
    setDetailSessionId(row.id)
  }

  const renderSessionItem = (row: ListRow) => {
    const isHighlighted = highlightedSessionIds.includes(row.id)
    const isRenaming = renamingSessionId === row.id
    const isActive = row.id === activeSessionId
    const activity = sessionActivityMap.get(row.id)
    const parts = participantsBySession[row.id] ?? []
    const workspaceLabel = sessionWorkspaceLabels.get(row.id)
    const showWorkspaceSubline = filter.kind !== 'workspace' && !!workspaceLabel
    return (
      <SidebarMenuItem key={row.id}>
        <SidebarMenuButton
          isActive={isActive}
          data-testid="v2-session-row"
          data-session-id={row.id}
          data-active={isActive ? "true" : "false"}
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
                  )}
                  data-testid="v2-session-row-title"
                  >
                    {row.title || t('chat.newChat', 'New Chat')}
                  </span>
                  {row.lastMessageAt && (
                    <span className="shrink-0 font-mono text-[10.5px] text-faint">
                      {formatRelativeTime(row.lastMessageAt)}
                    </span>
                  )}
                  {!isActive && row.hasUnread && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-coral"
                      aria-label={t('sidebar.unread', 'Unread')}
                    />
                  )}
                  {!isActive && isHighlighted && (
                    <span className="shrink-0 rounded-full bg-coral px-1.5 py-px text-[10px] font-semibold leading-4 text-coral-foreground">
                      {t('chat.newSessionBadge', 'NEW')}
                    </span>
                  )}
                </>
              )}
            </div>
            {!isRenaming && showWorkspaceSubline && (
              <span
                className="w-full truncate font-mono text-[11px] text-faint"
                data-testid="v2-session-row-workspace"
              >
                {workspaceLabel}
              </span>
            )}
            {/* Preview line: single line from last_message_preview. */}
            {!isRenaming && row.lastMessagePreview && (
              <div
                className="w-full truncate text-[12px] leading-[1.45] text-muted-foreground"
                data-testid="v2-session-row-preview"
              >
                {row.lastMessagePreview}
              </div>
            )}
            {/* Participants cluster + activity badge */}
            {!isRenaming && (parts.length > 0 || activity) && (
              <div className="flex w-full items-center gap-1.5" data-testid="v2-session-row-participants">
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
            Avoids overlapping title & preview text. AGENTS.md §2.
            Hidden while renaming so the trigger does not overlap the input. */}
        {!isRenaming && (
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
                onClick={(e) => handleViewDetail(e, row)}
              >
                <Info className="h-3.5 w-3.5 mr-2" />
                {t('sidebar.viewDetail', 'View detail')}
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
        )}
      </SidebarMenuItem>
    )
  }

  const renderPinnedHeader = () => (
    <div
      className="px-4 pt-3 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint"
      data-testid="v2-session-pinned-header"
    >
      {t('sidebar.pinned', 'Pinned')}{' '}
      <span className="font-mono text-faint/80">· {pinnedRows.length}</span>
    </div>
  )

  const renderPinnedDivider = () => (
    <div
      className="mx-4 my-2 border-t border-border-soft"
      data-testid="v2-session-pinned-divider"
      role="separator"
      aria-hidden
    />
  )

  const renderVirtualRow = (v: VirtualRow) => {
    if (v.kind === 'pinned-header') return renderPinnedHeader()
    if (v.kind === 'divider') return renderPinnedDivider()
    return renderSessionItem(v.row)
  }

  return (
    <div
      ref={columnRef}
      className="flex h-full flex-col min-w-0 border-r border-border bg-background"
      data-testid="v2-session-list-column"
    >
      <SessionSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <SessionDetailDialog
        sessionId={detailSessionId}
        teamId={teamIdFromList || null}
        hints={detailHints}
        participants={detailSessionId ? participantsBySession[detailSessionId] ?? [] : []}
        activity={detailSessionId ? sessionActivityMap.get(detailSessionId) : undefined}
        activeSessionId={activeSessionId}
        onOpenChange={(open) => {
          if (!open) {
            setDetailSessionId(null)
            setDetailHints(null)
          }
        }}
        onOpenSession={handleSelectSession}
      />

      <div
        className={cn(
          'flex min-w-0 items-center justify-between gap-1 border-b border-border py-3',
          compactHeader ? 'px-2' : 'px-4',
        )}
        data-tauri-drag-region
      >
        {sidebarCollapsed && (
          <div className="flex shrink-0 items-center gap-1">
            <TrafficLights />
            <SidebarCollapseToggle />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'truncate font-bold tracking-tight text-foreground',
              compactHeader ? 'text-[14px]' : 'text-[15px]',
            )}
          >
            {title}{' '}
            <span className="font-mono text-[11px] font-normal text-faint">
              · {filteredRows.length}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {showNewChatButton ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={handleNewChatClick}
                disabled={embedMode && creatingSession}
                title={t('chat.newChat', 'New Chat')}
              >
                {embedMode && creatingSession ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <SquarePen className="h-4 w-4" />
                )}
              </Button>
              {!embedMode ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => useUIStore.getState().openNewSessionDialog()}
                  title={t('chat.newMultiPersonSession', 'Group session')}
                >
                  <Users className="h-4 w-4" />
                </Button>
              ) : null}
            </>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-40"
            disabled={!sessionHeaderActionsEnabled}
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
              disabled={!sessionHeaderActionsEnabled}
              onClick={toggleShowCronSessions}
              title={showCronSessions ? t('sidebar.showAllSessions', 'Show all sessions') : t('sidebar.showCronSessions', 'Show scheduled sessions')}
            >
              <AnimatedClock className="h-4 w-4" animate={showCronSessions} />
            </Button>
          )}
          {onDismiss ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={onDismiss}
              title={t('common.close', 'Close')}
              aria-label={t('common.close', 'Close')}
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
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
            <p className="text-sm text-muted-foreground">
              {filter.kind === 'workspace'
                ? t('sidebar.noWorkspaceSessions', 'No sessions in this workspace yet')
                : t('sidebar.noConversations', 'No conversations')}
            </p>
          </div>
        ) : shouldVirtualize ? (
          <div
            style={{ height: `${sessionVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}
            data-testid="v2-session-list-virtual"
          >
            {sessionVirtualizer.getVirtualItems().map((virtualItem) => {
              const v = virtualRows[virtualItem.index]
              return (
                <div
                  key={v.key}
                  ref={(el) => { if (el) sessionVirtualizer.measureElement(el) }}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {renderVirtualRow(v)}
                </div>
              )
            })}
          </div>
        ) : (
          <SidebarMenu>
            {filter.kind === 'all' && pinnedRows.length > 0 && (
              <>
                {renderPinnedHeader()}
                {pinnedRows.map(renderSessionItem)}
                {regularRows.length > 0 && renderPinnedDivider()}
              </>
            )}
            {(filter.kind === 'all' ? regularRows : filteredRows).map(renderSessionItem)}
          </SidebarMenu>
        )}
        {listHasMore && (
          <div className="px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center rounded-md text-[12px] text-muted-foreground hover:text-foreground"
              disabled={listLoading}
              onClick={() => void loadMoreSessions()}
            >
              {listLoading
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : t('sidebar.loadMoreSessions', 'Load more')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
