import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Search, SquarePen, Loader2, MessageSquare, Pin, Archive, Pencil, Ellipsis } from 'lucide-react'
import { useSessionStore } from '@/stores/session'
import { useStreamingStore } from '@/stores/streaming'
import { useUIStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCronStore } from '@/stores/cron'
import { useSessionListStore } from '@/stores/session-list-store'
import { Button } from '@/components/ui/button'
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
import type { Session } from '@/stores/session-types'

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

  const allSessions = useSessionStore((s) => s.sessions)
  const pinnedSessionIds = useSessionStore((s) => s.pinnedSessionIds)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const isLoading = useSessionStore((s) => s.isLoading)
  const isLoadingMore = useSessionStore((s) => s.isLoadingMore)
  const hasMoreSessions = useSessionStore((s) => s.hasMoreSessions)
  const visibleSessionCount = useSessionStore((s) => s.visibleSessionCount)
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
  const loadMoreSessions = useSessionStore((s) => s.loadMoreSessions)
  const cronSessionIds = useCronStore((s) => s.cronSessionIds)
  const showCronSessions = useCronStore((s) => s.showCronSessions)
  const toggleShowCronSessions = useCronStore((s) => s.toggleShowCronSessions)

  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const hasWorkspace = !!workspacePath

  const [searchOpen, setSearchOpen] = React.useState(false)
  const [renamingSessionId, setRenamingSessionId] = React.useState<string | null>(null)
  const [actorSessionIds, setActorSessionIds] = React.useState<Set<string> | null>(null)
  const [actorLoading, setActorLoading] = React.useState(false)

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

  const baseSessions = React.useMemo(
    () => allSessions
      .filter((s) => !s.parentID)
      .filter((s) => showCronSessions ? cronSessionIds.has(s.id) : !cronSessionIds.has(s.id))
      .sort((a, b) => {
        const aPinned = pinnedSessionIds.includes(a.id)
        const bPinned = pinnedSessionIds.includes(b.id)
        if (aPinned !== bPinned) return aPinned ? -1 : 1
        return b.updatedAt.getTime() - a.updatedAt.getTime()
      })
      .slice(0, visibleSessionCount),
    [allSessions, cronSessionIds, pinnedSessionIds, showCronSessions, visibleSessionCount],
  )

  const filteredSessions = React.useMemo(() => {
    if (filter.kind === 'all') return baseSessions
    if (filter.kind === 'pinned') {
      return allSessions
        .filter((s) => !s.parentID && pinnedSessionIds.includes(s.id))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    }
    if (filter.kind === 'idea') {
      return allSessions
        .filter((s) => !s.parentID && (s as Session).ideaId === filter.ideaId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    }
    if (filter.kind === 'actor') {
      if (!actorSessionIds) return []
      return allSessions
        .filter((s) => !s.parentID && actorSessionIds.has(s.id))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    }
    return baseSessions
  }, [filter, baseSessions, allSessions, pinnedSessionIds, actorSessionIds])

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
      useUIStore.setState({ draftIdeaId: filter.ideaId })
    }
  }

  const handleSelectSession = (id: string) => useUIStore.getState().switchToSession(id)
  const handleStartRename = (e: React.MouseEvent, id: string) => { e.stopPropagation(); setRenamingSessionId(id) }
  const handleRenameConfirm = async (id: string, newTitle: string) => {
    if (newTitle.trim() && newTitle !== allSessions.find((s) => s.id === id)?.title) {
      try { await updateSessionTitle(id, newTitle.trim()) }
      catch (e) { console.error('[SessionListColumn] rename failed:', e) }
    }
    setRenamingSessionId(null)
  }
  const handleArchive = async (e: React.MouseEvent, id: string) => { e.stopPropagation(); await archiveSession(id) }
  const handleTogglePinned = (e: React.MouseEvent, id: string) => { e.stopPropagation(); toggleSessionPinned(id) }

  const renderSessionItem = (session: Session) => {
    const isHighlighted = highlightedSessionIds.includes(session.id)
    const isRenaming = renamingSessionId === session.id
    const isPinned = pinnedSessionIds.includes(session.id)
    const activity = sessionActivityMap.get(session.id)
    return (
      <SidebarMenuItem key={session.id}>
        <SidebarMenuButton
          isActive={session.id === activeSessionId}
          className={cn(
            'h-auto py-2 pr-8 transition-all duration-300',
            session.id === activeSessionId &&
              "relative z-0 data-[active=true]:!bg-muted/40 data-[active=true]:font-medium before:pointer-events-none before:absolute before:left-0 before:top-1/2 before:z-10 before:h-[72%] before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-primary before:content-['']",
            isHighlighted && session.id !== activeSessionId && 'bg-emerald-500/15 ring-1 ring-emerald-500/30',
          )}
          onClick={() => { if (!isRenaming) handleSelectSession(session.id) }}
          onDoubleClick={(e) => { e.stopPropagation(); handleStartRename(e, session.id) }}
        >
          <div className="flex flex-col items-start gap-1 flex-1 min-w-0">
            <div className="flex items-center gap-1.5 w-full">
              {isRenaming ? (
                <SessionRenameInput
                  defaultValue={session.title}
                  onConfirm={(v) => handleRenameConfirm(session.id, v)}
                  onCancel={() => setRenamingSessionId(null)}
                />
              ) : (
                <>
                  <span className="truncate text-left text-l">{session.title}</span>
                  {isPinned && <Pin className="h-3 w-3 shrink-0 text-amber-500 fill-amber-500/20" />}
                  {session.id !== activeSessionId && isHighlighted && (
                    <span className="shrink-0 text-[10px] font-medium text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">
                      {t('chat.newSessionBadge', 'NEW')}
                    </span>
                  )}
                </>
              )}
            </div>
            {!isRenaming && (
              <div className="flex min-w-0 items-center gap-2 w-full">
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatRelativeTime(session.updatedAt)}
                  {session.messageCount !== undefined && (
                    <> · {t('chat.messageCountShort', { count: session.messageCount })}</>
                  )}
                </span>
                <SessionActivityBadge activity={activity} />
              </div>
            )}
          </div>
        </SidebarMenuButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 opacity-0 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 transition-opacity hover:bg-black/10 dark:hover:bg-white/10 rounded-md"
              onClick={(e) => e.stopPropagation()}
            >
              <Ellipsis className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={(e) => handleTogglePinned(e as unknown as React.MouseEvent, session.id)}>
              <Pin className="h-4 w-4 mr-2" />
              {isPinned ? t('sidebar.unpin', 'Unpin') : t('sidebar.pinToTop', 'Pin to top')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => handleStartRename(e, session.id)}>
              <Pencil className="h-4 w-4 mr-2" />
              {t('sidebar.rename', 'Rename')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => handleArchive(e as unknown as React.MouseEvent, session.id)}>
              <Archive className="h-4 w-4 mr-2" />
              {t('sidebar.archive', 'Archive')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    )
  }

  return (
    <div className="flex h-full flex-col min-w-0">
      <SessionSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />

      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/60">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{title}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {t('sidebar.countActiveRecent', '{{count}} active · recent first', { count: filteredSessions.length })}
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
        ) : isLoading && filteredSessions.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <MessageSquare className="h-8 w-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">{t('sidebar.noConversations', 'No conversations')}</p>
          </div>
        ) : (
          <SidebarMenu>
            {filteredSessions.map(renderSessionItem)}
          </SidebarMenu>
        )}

        {filter.kind === 'all' && hasMoreSessions && filteredSessions.length > 0 && (
          <div className="px-2 py-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => loadMoreSessions()}
              disabled={isLoadingMore}
            >
              {isLoadingMore ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{t('sidebar.loadingMore', 'Loading...')}</>
              ) : (
                t('sidebar.loadMore', 'Load More')
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
