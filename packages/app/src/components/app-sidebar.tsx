import * as React from "react"
import { useTranslation } from "react-i18next"
import { Search, SquarePen, MessageSquare, Loader2, Archive, PanelLeftIcon, Pencil, Ellipsis, Settings, Pin, SquarePlus, UserPlus, Lightbulb } from "lucide-react"
import { isWorkspaceUIVariant } from "@/lib/ui-variant"

import { useSessionStore } from "@/stores/session"
import { useStreamingStore } from "@/stores/streaming"
import { useUIStore } from "@/stores/ui"
import { useWorkspaceStore } from "@/stores/workspace"
import { useCronStore } from "@/stores/cron"
import { useTeamModeStore } from "@/stores/team-mode"
import { useP2pEngineStore } from "@/stores/p2p-engine"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { cn, isTauri } from "@/lib/utils"
import { formatRelativeTime } from "@/lib/date-format"
import { Button } from "@/components/ui/button"
import { AnimatedClock } from "@/components/ui/animated-clock"
import { DefaultBottomNav } from "@/components/navigation/DefaultBottomNav"
import { ShortcutsPanel, ActorsView, IdeasView } from "@/components/panel"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { TrafficLights } from "@/components/ui/traffic-lights"
import { buildSessionListActivityMap, type SessionListActivity } from "@/lib/session-list-activity"
import { SessionSearchDialog } from "@/components/sidebar/session-search-dialog"
import { NavRail } from "@/components/sidebar/NavRail"

function SessionActivityBadge({ activity }: { activity?: SessionListActivity }) {
  const { t } = useTranslation()
  if (!activity) return null
  if (activity.state === "running") {
    return (
      <Loader2
        className="h-3.5 w-3.5 shrink-0 animate-spin text-primary"
        aria-label={t("sidebar.sessionRunning", "Running")}
      />
    )
  }

  return (
    <span className="min-w-0 shrink rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold leading-4 text-emerald-600">
      <span className="block truncate">
        {t("sidebar.awaitingConfirmation", "Awaiting confirmation")}
      </span>
    </span>
  )
}

/** Sidebar collapse control only (workspace variant sidebar header). */
export function SidebarCollapseToggle({ className }: { className?: string }) {
  const { toggleSidebar } = useSidebar()
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7 text-muted-foreground hover:text-foreground", className)}
      onClick={toggleSidebar}
      title="Collapse sidebar"
      aria-label="Collapse sidebar"
    >
      <PanelLeftIcon className="h-4 w-4" />
    </Button>
  )
}

/** Search, scheduled-session filter, and new chat — used below quick links in workspace sidebar or in collapsed main header. */
export function SidebarSecondarySessionActions({
  className,
  includeSearchDialog = true,
  /** When true, only the new-chat control is shown (workspace shell + collapsed sidebar inset header). */
  newChatOnly = false,
  /** In sidebar: full-width rounded new-chat row; search/cron stay on a line above, right-aligned. */
  newChatVariant = "compact",
}: {
  className?: string
  /** When false, omit the dialog + global ⌘K handler (use if another instance already owns search, e.g. collapsed header vs expanded sidebar). */
  includeSearchDialog?: boolean
  newChatOnly?: boolean
  newChatVariant?: "compact" | "sidebarWide"
}) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const showCronSessions = useCronStore(s => s.showCronSessions)
  const toggleShowCronSessions = useCronStore(s => s.toggleShowCronSessions)
  const [searchOpen, setSearchOpen] = React.useState(false)

  const hasWorkspace = !!workspacePath
  const showSearchAndCron = !newChatOnly
  const effectiveIncludeSearchDialog = includeSearchDialog && showSearchAndCron

  React.useEffect(() => {
    if (!effectiveIncludeSearchDialog) return
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (hasWorkspace) {
          setSearchOpen((open) => !open)
        }
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [hasWorkspace, effectiveIncludeSearchDialog])

  const handleNewSession = () => {
    if (!hasWorkspace) return
    useUIStore.getState().startNewChat()
  }

  const newChatLabel = t("chat.newChat", "New Chat")
  const useWideNewChat = newChatVariant === "sidebarWide" && !newChatOnly

  /** Match sidebar surface (#fff light); border uses `secondary` (same fill as New Chat) so edge reads as that gray, not page `background`. */
  const workspaceToolbarSquareBtn =
    "h-9 w-9 shrink-0 rounded-lg border border-secondary !bg-sidebar p-0 font-normal shadow-none disabled:opacity-40 dark:!bg-sidebar"

  const searchCronRow = showSearchAndCron ? (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-40"
        disabled={!hasWorkspace}
        onClick={() => includeSearchDialog && setSearchOpen(true)}
        title={hasWorkspace ? t('sidebar.searchWithShortcut', 'Search (⌘K)') : t('sidebar.selectWorkspaceFirst', 'Please select a workspace first')}
      >
        <Search className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "h-7 w-7 transition-colors disabled:opacity-40",
          showCronSessions
            ? "text-foreground bg-muted"
            : "text-muted-foreground hover:text-foreground"
        )}
        disabled={!hasWorkspace}
        onClick={toggleShowCronSessions}
        title={showCronSessions ? t('sidebar.showAllSessions', 'Show all sessions') : t('sidebar.showCronSessions', 'Show scheduled sessions')}
      >
        <AnimatedClock className="h-4 w-4" animate={showCronSessions} />
      </Button>
    </>
  ) : null

  const newChatCompactIcon = (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-40"
      onClick={handleNewSession}
      disabled={!hasWorkspace}
      title={hasWorkspace ? newChatLabel : t('sidebar.selectWorkspaceFirst', 'Please select a workspace first')}
    >
      <SquarePen className="h-4 w-4" />
    </Button>
  )

  return (
    <>
      {effectiveIncludeSearchDialog && (
        <SessionSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      )}
      {useWideNewChat ? (
        <div className={cn("flex w-full items-stretch gap-1.5", className)}>
          <Button
            variant="secondary"
            className="h-9 min-w-0 flex-1 justify-center gap-2 rounded-lg px-3 font-normal shadow-none disabled:opacity-40"
            onClick={handleNewSession}
            disabled={!hasWorkspace}
            title={hasWorkspace ? newChatLabel : t('sidebar.selectWorkspaceFirst', 'Please select a workspace first')}
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="truncate">{newChatLabel}</span>
          </Button>
          {showSearchAndCron && (
            <>
              <Button
                variant="outline"
                className={cn(
                  workspaceToolbarSquareBtn,
                  "text-muted-foreground hover:!bg-muted/30",
                )}
                disabled={!hasWorkspace}
                onClick={() => includeSearchDialog && setSearchOpen(true)}
                title={hasWorkspace ? t('sidebar.searchWithShortcut', 'Search (⌘K)') : t('sidebar.selectWorkspaceFirst', 'Please select a workspace first')}
              >
                <Search className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                className={cn(
                  workspaceToolbarSquareBtn,
                  "hover:!bg-muted/30",
                  showCronSessions
                    ? "!bg-secondary/35 text-foreground"
                    : "text-muted-foreground",
                )}
                disabled={!hasWorkspace}
                onClick={toggleShowCronSessions}
                title={showCronSessions ? t('sidebar.showAllSessions', 'Show all sessions') : t('sidebar.showCronSessions', 'Show scheduled sessions')}
              >
                <AnimatedClock className="h-4 w-4" animate={showCronSessions} />
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className={cn("flex items-center gap-0.5", className)}>
          {searchCronRow}
          {newChatCompactIcon}
        </div>
      )}
    </>
  )
}

// Full header row: collapse + search + cron + new chat (default UI variant).
export function SidebarIconGroup({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <SidebarCollapseToggle />
      <SidebarSecondarySessionActions />
    </div>
  )
}

function DefaultShortcutsHeaderControls() {
  const { t } = useTranslation()
  const openSettings = useUIStore(s => s.openSettings)
  const newShortcutLabel = t('shortcuts.newShortcut', 'New Shortcut')

  return (
    <div className="flex items-center gap-0.5">
      <SidebarCollapseToggle />
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={() => openSettings('shortcuts')}
        title={newShortcutLabel}
        aria-label={newShortcutLabel}
      >
        <SquarePlus className="h-4 w-4" />
      </Button>
    </div>
  )
}

async function notImplementedToast(message: string) {
  const { toast } = await import('sonner')
  toast(message)
}

function DefaultActorsHeaderControls() {
  const { t } = useTranslation()
  const searchLabel = t('common.search', 'Search')
  const inviteLabel = t('sidebar.invite', 'Invite member')
  return (
    <div className="flex items-center gap-0.5">
      <SidebarCollapseToggle />
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={() => void notImplementedToast(t('common.comingSoon', 'Coming soon'))}
        title={searchLabel}
        aria-label={searchLabel}
      >
        <Search className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={() => void notImplementedToast(t('common.comingSoon', 'Coming soon'))}
        title={inviteLabel}
        aria-label={inviteLabel}
      >
        <UserPlus className="h-4 w-4" />
      </Button>
    </div>
  )
}

function DefaultIdeasHeaderControls() {
  const { t } = useTranslation()
  const searchLabel = t('common.search', 'Search')
  const newIdeaLabel = t('sidebar.newIdea', 'New idea')
  return (
    <div className="flex items-center gap-0.5">
      <SidebarCollapseToggle />
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={() => void notImplementedToast(t('common.comingSoon', 'Coming soon'))}
        title={searchLabel}
        aria-label={searchLabel}
      >
        <Search className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={() => void notImplementedToast(t('common.comingSoon', 'Coming soon'))}
        title={newIdeaLabel}
        aria-label={newIdeaLabel}
      >
        <Lightbulb className="h-4 w-4" />
      </Button>
    </div>
  )
}

// Workspace selector button for sidebar footer
function WorkspaceSelectorButton() {
  const { t } = useTranslation()
  const workspaceName = useWorkspaceStore(s => s.workspaceName)
  const isLoadingWorkspace = useWorkspaceStore(s => s.isLoadingWorkspace)
  const setWorkspace = useWorkspaceStore(s => s.setWorkspace)
  const teamMode = useTeamModeStore(s => s.teamMode)
  const engineInit = useP2pEngineStore(s => s.init)
  const engineFetch = useP2pEngineStore(s => s.fetch)
  const [isSelecting, setIsSelecting] = React.useState(false)

  // Initialize P2P engine store when in team mode. The UI no longer renders
  // connection status here, but the engine still needs to come up so sync works.
  React.useEffect(() => {
    if (!teamMode || !isTauri()) return
    let cleanup: (() => void) | undefined
    engineInit().then((c) => { cleanup = c })
    void engineFetch()
    return () => { cleanup?.() }
  }, [teamMode, engineFetch, engineInit])

  const handleOpenFolder = async () => {
    if (!isTauri()) {
      console.log('[Web Mode] Folder dialog not available')
      return
    }
    
    setIsSelecting(true)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('workspace.selectWorkspace', 'Select Workspace'),
      })
      
      if (selected && typeof selected === 'string') {
        await setWorkspace(selected)
      }
    } catch (error) {
      console.error('Failed to open folder dialog:', error)
    } finally {
      setIsSelecting(false)
    }
  }

  const isLoading = isLoadingWorkspace || isSelecting

  const buttonContent = (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-muted-foreground hover:text-foreground max-w-[180px]"
      disabled={isLoading}
      onClick={handleOpenFolder}
    >
      {isLoading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin shrink-0" />}
      <span className="truncate text-xs" data-testid="workspace-name">
        {workspaceName || t('workspace.selectWorkspace', 'Select Workspace')}
      </span>
    </Button>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {buttonContent}
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>{workspaceName ? t('sidebar.currentWorkspace', 'Current: {{path}}', { path: workspaceName }) : t('workspace.selectWorkspace', 'Select Workspace')}</p>
      </TooltipContent>
    </Tooltip>
  )
}

// Inline editing input component for session rename
function SessionRenameInput({
  defaultValue,
  onConfirm,
  onCancel,
}: {
  defaultValue: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, [defaultValue]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      const value = inputRef.current?.value.trim();
      if (value) onConfirm(value);
      else onCancel();
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      defaultValue={defaultValue}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        const value = inputRef.current?.value.trim();
        if (value) onConfirm(value);
        else onCancel();
      }}
      onClick={(e) => e.stopPropagation()}
      className="flex-1 bg-transparent border border-primary/50 rounded px-1.5 py-0.5 text-sm outline-none focus:border-primary min-w-0"
    />
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation()
  const allSessions = useSessionStore(s => s.sessions)
  const pinnedSessionIds = useSessionStore(s => s.pinnedSessionIds)
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const isLoading = useSessionStore(s => s.isLoading)
  const isLoadingMore = useSessionStore(s => s.isLoadingMore)
  const hasMoreSessions = useSessionStore(s => s.hasMoreSessions)
  const visibleSessionCount = useSessionStore(s => s.visibleSessionCount)
  const highlightedSessionIds = useSessionStore(s => s.highlightedSessionIds)
  const sessionStatuses = useSessionStore(s => s.sessionStatuses) || {}
  const pendingQuestionIdsBySession = useSessionStore(s => s.pendingQuestionIdsBySession) || {}
  const pendingQuestions = useSessionStore(s => s.pendingQuestions) || []
  const pendingPermissions = useSessionStore(s => s.pendingPermissions) || []
  const streamingMessageId = useStreamingStore(s => s.streamingMessageId)
  const childSessionStreaming = useStreamingStore(s => s.childSessionStreaming)
  const archiveSession = useSessionStore(s => s.archiveSession)
  const updateSessionTitle = useSessionStore(s => s.updateSessionTitle)
  const toggleSessionPinned = useSessionStore(s => s.toggleSessionPinned)
  const loadMoreSessions = useSessionStore(s => s.loadMoreSessions)
  const cronSessionIds = useCronStore(s => s.cronSessionIds)
  const showCronSessions = useCronStore(s => s.showCronSessions)

  // Rename state
  const [renamingSessionId, setRenamingSessionId] = React.useState<string | null>(null)

  // UI-level pagination: filter by cron toggle, then slice to visible count
  const sessions = React.useMemo(
    () => allSessions
      .filter(s => !s.parentID)
      .filter(s => showCronSessions
        ? cronSessionIds.has(s.id)
        : !cronSessionIds.has(s.id)
      )
      .sort((a, b) => {
        const aPinned = pinnedSessionIds.includes(a.id)
        const bPinned = pinnedSessionIds.includes(b.id)
        if (aPinned !== bPinned) return aPinned ? -1 : 1
        return b.updatedAt.getTime() - a.updatedAt.getTime()
      })
      .slice(0, visibleSessionCount),
    [allSessions, cronSessionIds, pinnedSessionIds, showCronSessions, visibleSessionCount],
  )
  const pinnedSessions = React.useMemo(
    () => sessions.filter((session) => pinnedSessionIds.includes(session.id)),
    [sessions, pinnedSessionIds],
  )
  const unpinnedSessions = React.useMemo(
    () => sessions.filter((session) => !pinnedSessionIds.includes(session.id)),
    [sessions, pinnedSessionIds],
  )
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
  
  const openSettings = useUIStore(s => s.openSettings)
  const defaultNavTab = useUIStore(s => s.defaultNavTab)

  const defaultSidebarContent = isWorkspaceUIVariant() ? 'session' : defaultNavTab

  const handleSelectSession = (id: string) => {
    useUIStore.getState().switchToSession(id)
  }

  const handleArchiveSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await archiveSession(id)
  }

  const handleStartRename = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setRenamingSessionId(id)
  }

  const handleRenameConfirm = async (id: string, newTitle: string) => {
    if (newTitle.trim() && newTitle !== allSessions.find(s => s.id === id)?.title) {
      try {
        await updateSessionTitle(id, newTitle.trim())
      } catch (error) {
        console.error("[AppSidebar] Failed to rename session:", error)
        // Error is already handled in the store
      }
    }
    setRenamingSessionId(null)
  }

  const handleRenameCancel = () => {
    setRenamingSessionId(null)
  }

  const handleTogglePinned = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    toggleSessionPinned(id)
  }

  // Format date for display with relative time
  const formatDate = (date: Date) => formatRelativeTime(date)

  const renderSessionItem = (session: typeof sessions[number]) => {
    const isHighlighted = highlightedSessionIds.includes(session.id)
    const isRenaming = renamingSessionId === session.id
    const isPinned = pinnedSessionIds.includes(session.id)
    const activity = sessionActivityMap.get(session.id)

    return (
      <SidebarMenuItem key={session.id}>
        <SidebarMenuButton
          isActive={session.id === activeSessionId}
          className={cn(
            "h-auto py-2 pr-8 transition-all duration-300",
            isWorkspaceUIVariant() &&
              session.id === activeSessionId &&
              "relative z-0 data-[active=true]:!bg-muted/40 data-[active=true]:font-medium before:pointer-events-none before:absolute before:left-0 before:top-1/2 before:z-10 before:h-[72%] before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-primary before:content-['']",
            isHighlighted &&
              session.id !== activeSessionId &&
              "bg-emerald-500/15 ring-1 ring-emerald-500/30"
          )}
          onClick={() => {
            if (!isRenaming) {
              handleSelectSession(session.id)
            }
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            handleStartRename(e, session.id)
          }}
        >
          <div className="flex flex-col items-start gap-1 flex-1 min-w-0">
            <div className="flex items-center gap-1.5 w-full">
              {isRenaming ? (
                <SessionRenameInput
                  defaultValue={session.title}
                  onConfirm={(newTitle) => handleRenameConfirm(session.id, newTitle)}
                  onCancel={handleRenameCancel}
                />
              ) : (
                <>
                  <span className="truncate text-left text-l">
                    {session.title}
                  </span>
                  {isPinned && (
                    <Pin className="h-3 w-3 shrink-0 text-amber-500 fill-amber-500/20" />
                  )}
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
                  {formatDate(session.updatedAt)}
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
            <DropdownMenuItem
              onClick={(e) => handleTogglePinned(e as unknown as React.MouseEvent, session.id)}
            >
              <Pin className="h-4 w-4 mr-2" />
              {isPinned
                ? t('sidebar.unpin', 'Unpin')
                : t('sidebar.pinToTop', 'Pin to top')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => handleStartRename(e, session.id)}
            >
              <Pencil className="h-4 w-4 mr-2" />
              {t('sidebar.rename', 'Rename')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => handleArchiveSession(e as unknown as React.MouseEvent, session.id)}
            >
              <Archive className="h-4 w-4 mr-2" />
              {t('sidebar.archive', 'Archive')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    )
  }

  return (
    <Sidebar variant="sidebar" {...props}>
      <div className="flex h-full flex-col" data-onboarding-id="main-sidebar">
        {/* Header: custom traffic lights (Tauri) or spacer + icon group */}
        <SidebarHeader
          className="flex-row items-center h-12 shrink-0 px-2 pt-0 pb-0"
          data-tauri-drag-region
        >
          <TrafficLights />
          {/* Flexible drag region */}
          <div className="flex-1" data-tauri-drag-region />
          {isWorkspaceUIVariant() ? (
            <SidebarCollapseToggle />
          ) : defaultSidebarContent === 'shortcuts' ? (
            <DefaultShortcutsHeaderControls />
          ) : defaultSidebarContent === 'actors' ? (
            <DefaultActorsHeaderControls />
          ) : defaultSidebarContent === 'ideas' ? (
            <DefaultIdeasHeaderControls />
          ) : (
            <SidebarIconGroup />
          )}
        </SidebarHeader>

        <SidebarContent className="overflow-hidden">
          {isWorkspaceUIVariant() ? (
            <NavRail />
          ) : (
            <SidebarGroup className="!px-0 !pb-0 !pt-0 min-h-0 flex-1 overflow-hidden">
              {defaultSidebarContent === 'session' && (
                <div
                  data-testid="sidebar-session-scroll"
                  className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
                >
                  <SidebarMenu>
                    {isLoading && sessions.length === 0 ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : sessions.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-8 text-center">
                        <MessageSquare className="h-8 w-8 text-muted-foreground mb-2" />
                        <p className="text-sm text-muted-foreground">
                          {t('sidebar.noConversations', 'No conversations')}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t('sidebar.clickToStartChat', 'Click the edit icon to start a new chat')}
                        </p>
                      </div>
                    ) : (
                      <>
                        {pinnedSessions.length > 0 && (
                          <>
                            <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                              {t('sidebar.pinnedSessions', 'Pinned')}
                            </div>
                            {pinnedSessions.map(renderSessionItem)}
                          </>
                        )}
                        {unpinnedSessions.length > 0 && (
                          <>
                            {pinnedSessions.length > 0 && (
                              <div className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                                {t('sidebar.allSessions', 'All sessions')}
                              </div>
                            )}
                            {unpinnedSessions.map(renderSessionItem)}
                          </>
                        )}
                      </>
                    )}
                  </SidebarMenu>

                  {hasMoreSessions && sessions.length > 0 && (
                    <div className="px-2 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full"
                        onClick={() => loadMoreSessions()}
                        disabled={isLoadingMore}
                      >
                        {isLoadingMore ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            {t('sidebar.loadingMore', 'Loading...')}
                          </>
                        ) : (
                          t('sidebar.loadMore', 'Load More')
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {defaultSidebarContent === 'shortcuts' && (
                <div className="min-h-0 flex-1 overflow-hidden">
                  <ShortcutsPanel />
                </div>
              )}

              {defaultSidebarContent === 'actors' && (
                <div className="min-h-0 flex-1 overflow-hidden">
                  <ActorsView />
                </div>
              )}

              {defaultSidebarContent === 'ideas' && (
                <div className="min-h-0 flex-1 overflow-hidden">
                  <IdeasView />
                </div>
              )}
            </SidebarGroup>
          )}

        </SidebarContent>

        <SidebarFooter className="gap-1 px-2 pb-1 pt-1">
          {!isWorkspaceUIVariant() && <DefaultBottomNav />}

          {isWorkspaceUIVariant() && (
            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground gap-1.5"
                onClick={() => openSettings()}
              >
                <Settings className="h-3.5 w-3.5 shrink-0" />
                {t('common.settings', 'Settings')}
              </Button>
              <WorkspaceSelectorButton />
            </div>
          )}

        </SidebarFooter>
      </div>
    </Sidebar>
  )
}
