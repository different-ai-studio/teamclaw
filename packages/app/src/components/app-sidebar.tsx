import * as React from "react"
import { useTranslation } from "react-i18next"
import { Search, SquarePen, MessageSquare, Loader2, Archive, PanelLeftIcon, FolderOpen, Users, Cloud, Pencil, Ellipsis, Clock, Bookmark, Settings, Pin, Shapes, SquarePlus, } from "lucide-react"
import { isWorkspaceUIVariant } from "@/lib/ui-variant"

import { useSessionStore } from "@/stores/session"
import { useStreamingStore } from "@/stores/streaming"
import { useUIStore } from "@/stores/ui"
import { useWorkspaceStore } from "@/stores/workspace"
import { useTabsStore } from "@/stores/tabs"
import { useCronStore } from "@/stores/cron"
import { useTeamModeStore } from "@/stores/team-mode"
import { useTeamOssStore } from "@/stores/team-oss"
import { useP2pEngineStore } from "@/stores/p2p-engine"
import { NodeStatusPopover } from "@/components/NodeStatusPopover"
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
import { RightPanel, ShortcutsPanel } from "@/components/panel"
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
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"

import type { EmbeddedSidebarSettingsSection } from "@/stores/ui"

const WORKSPACE_QUICK_SECTIONS: {
  id: EmbeddedSidebarSettingsSection
  labelKey: string
  fallback: string
  icon: React.ComponentType<{ className?: string }>
  color: string
}[] = [
  { id: 'automation', labelKey: 'settings.nav.automation', fallback: 'Automation', icon: Clock, color: 'text-amber-500' },
  { id: 'rolesSkills', labelKey: 'settings.nav.rolesSkills', fallback: 'Roles & Skills', icon: Shapes, color: 'text-foreground' },
]

// Status indicator for the active session in the sidebar
function SidebarSessionStatusIndicator() {
  const sessionStatus = useSessionStore(s => s.sessionStatus)
  const pendingPermissions = useSessionStore(s => s.pendingPermissions)
  const pendingQuestions = useSessionStore(s => s.pendingQuestions)
  const streamingMessageId = useStreamingStore(s => s.streamingMessageId)

  if (pendingPermissions.length > 0 || pendingQuestions.length > 0) {
    return (
      <span className="shrink-0 text-[10px] font-medium text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">
        等待确认
      </span>
    )
  }

  if (sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry' || streamingMessageId) {
    return (
      <Loader2 className="shrink-0 h-3 w-3 animate-spin text-muted-foreground/70" />
    )
  }

  return null
}

// Session search dialog component
function SessionSearchDialog({ 
  open, 
  onOpenChange 
}: { 
  open: boolean
  onOpenChange: (open: boolean) => void 
}) {
  const { t } = useTranslation()
  const sessions = useSessionStore(s => s.sessions)
  const activeSessionId = useSessionStore(s => s.activeSessionId)

  // Format date for display
  const formatDate = (date: Date) => formatRelativeTime(date)

  const handleSelectSession = (sessionId: string) => {
    useUIStore.getState().switchToSession(sessionId)
    onOpenChange(false)
  }

  return (
    <CommandDialog 
      open={open} 
      onOpenChange={onOpenChange}
      title={t('sidebar.searchSessions', 'Search Sessions')}
      description={t('sidebar.searchDescription', 'Search and navigate to a session')}
    >
      <CommandInput placeholder={t('sidebar.searchPlaceholder', 'Search sessions...')} />
      <CommandList className="max-h-[400px]">
        <CommandEmpty>{t('sidebar.noSessionsFound', 'No sessions found.')}</CommandEmpty>
        <CommandGroup heading={t('sidebar.sessions', 'Sessions')}>
          {sessions.map((session) => (
            <CommandItem
              key={session.id}
              value={`${session.id} ${session.title}`}
              onSelect={() => handleSelectSession(session.id)}
            >
              <MessageSquare className="h-4 w-4 mr-3 text-muted-foreground shrink-0" />
              <div className="flex flex-col flex-1 min-w-0">
                <span className="truncate font-medium">{session.title}</span>
                <span className="text-xs text-muted-foreground">
                  {formatDate(session.updatedAt)}
                </span>
              </div>
              {activeSessionId === session.id && (
                <span className="text-xs text-emerald-500 font-medium ml-2 shrink-0">{t('sidebar.active', 'Active')}</span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
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
        title={hasWorkspace ? "Search (⌘K)" : t('sidebar.selectWorkspaceFirst', 'Please select a workspace first')}
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
                title={hasWorkspace ? "Search (⌘K)" : t('sidebar.selectWorkspaceFirst', 'Please select a workspace first')}
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

// Open the picked folder in a brand-new TeamClaw window with its own sidecar.
function OpenInNewWindowButton() {
  const { t } = useTranslation()
  const [busy, setBusy] = React.useState(false)

  if (!isTauri()) return null

  const handleClick = async () => {
    setBusy(true)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('workspace.openInNewWindow', '在新窗口打开工作区'),
      })
      if (!selected || typeof selected !== 'string') return
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('create_workspace_window', { workspacePath: selected })
    } catch (error) {
      console.error('[Window] Failed to open workspace in new window:', error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          disabled={busy}
          onClick={handleClick}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <SquarePlus className="h-3.5 w-3.5" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>{t('workspace.openInNewWindow', '在新窗口打开工作区')}</p>
      </TooltipContent>
    </Tooltip>
  )
}

// Workspace selector button for sidebar footer
function WorkspaceSelectorButton() {
  const { t } = useTranslation()
  const workspaceName = useWorkspaceStore(s => s.workspaceName)
  const isLoadingWorkspace = useWorkspaceStore(s => s.isLoadingWorkspace)
  const setWorkspace = useWorkspaceStore(s => s.setWorkspace)
  const teamMode = useTeamModeStore(s => s.teamMode)
  const teamModeP2pConnected = useTeamModeStore(s => s.p2pConnected)
  const ossConfigured = useTeamOssStore(s => s.configured)
  const ossConnected = useTeamOssStore(s => s.connected)
  const engineInitialized = useP2pEngineStore(s => s.initialized)
  const engineStatus = useP2pEngineStore(s => s.snapshot.status)
  const engineStreamHealth = useP2pEngineStore(s => s.snapshot.streamHealth)
  const engineInit = useP2pEngineStore(s => s.init)
  const engineFetch = useP2pEngineStore(s => s.fetch)
  const [isSelecting, setIsSelecting] = React.useState(false)

  // Initialize P2P engine store when in team mode
  React.useEffect(() => {
    if (!teamMode || !isTauri()) return
    let cleanup: (() => void) | undefined
    engineInit().then((c) => { cleanup = c })
    void engineFetch()
    return () => { cleanup?.() }
  }, [teamMode, engineFetch, engineInit])

  // Prefer the engine snapshot for connection truth. Keep a narrow fallback to the
  // mirrored team-mode flag only before the engine store finishes initialization.
  const p2pConnected = engineStatus === 'connected' || (!engineInitialized && teamModeP2pConnected)
  const p2pStatusTone = p2pConnected
    ? engineStatus === 'connected' && engineStreamHealth !== 'healthy'
      ? 'degraded'
      : 'connected'
    : 'disconnected'

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
      className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground max-w-[180px]"
      disabled={isLoading}
      onClick={handleOpenFolder}
    >
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
      ) : teamMode && workspaceName && ossConfigured ? (
        <Cloud className={cn("h-4 w-4 shrink-0", ossConnected ? "text-blue-500" : "text-muted-foreground")} />
      ) : teamMode && workspaceName ? (
        <Users className={cn(
          "h-4 w-4 shrink-0",
          p2pStatusTone === 'connected'
            ? "text-blue-500"
            : p2pStatusTone === 'degraded'
              ? "text-amber-500"
              : "text-muted-foreground"
        )} data-testid="workspace-p2p-icon" data-p2p-status={p2pStatusTone} />
      ) : (
        <FolderOpen className="h-4 w-4 shrink-0" />
      )}
      <span className="truncate text-xs" data-testid="workspace-name">
        {workspaceName || t('workspace.selectWorkspace', 'Select Workspace')}
      </span>
    </Button>
  )

  // P2P mode: wrap in NodeStatusPopover for hover details
  if (teamMode && workspaceName && !ossConfigured) {
    return (
      <NodeStatusPopover>
        {buttonContent}
      </NodeStatusPopover>
    )
  }

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
  const { state: sidebarDisplayState } = useSidebar()
  const allSessions = useSessionStore(s => s.sessions)
  const pinnedSessionIds = useSessionStore(s => s.pinnedSessionIds)
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const isLoading = useSessionStore(s => s.isLoading)
  const isLoadingMore = useSessionStore(s => s.isLoadingMore)
  const hasMoreSessions = useSessionStore(s => s.hasMoreSessions)
  const visibleSessionCount = useSessionStore(s => s.visibleSessionCount)
  const highlightedSessionIds = useSessionStore(s => s.highlightedSessionIds)
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
  
  const openSettings = useUIStore(s => s.openSettings)
  const closeSettings = useUIStore(s => s.closeSettings)
  const defaultNavTab = useUIStore(s => s.defaultNavTab)
  const embeddedSettingsSection = useUIStore(s => s.embeddedSettingsSection)
  const openEmbeddedSettingsSection = useUIStore(s => s.openEmbeddedSettingsSection)
  const closeEmbeddedSettingsSection = useUIStore(s => s.closeEmbeddedSettingsSection)
  const clearSelection = useWorkspaceStore(s => s.clearSelection)
  const isPanelOpen = useWorkspaceStore(s => s.isPanelOpen)
  const activeWorkspacePanelTab = useWorkspaceStore(s => s.activeTab)
  const openPanel = useWorkspaceStore(s => s.openPanel)
  const closePanel = useWorkspaceStore(s => s.closePanel)

  const handleOpenEmbeddedSection = (section: EmbeddedSidebarSettingsSection) => {
    clearSelection()
    closeSettings()
    closePanel()
    useTabsStore.getState().hideAll()
    openEmbeddedSettingsSection(section)
  }

  const handleWorkspaceShortcutsPanel = () => {
    clearSelection()
    closeSettings()
    closeEmbeddedSettingsSection()
    useTabsStore.getState().hideAll()
    if (isPanelOpen && activeWorkspacePanelTab === "shortcuts") {
      closePanel()
    } else {
      openPanel("shortcuts")
    }
  }

  const shortcutsStripActive =
    isPanelOpen &&
    activeWorkspacePanelTab === "shortcuts" &&
    !embeddedSettingsSection
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

    return (
      <SidebarMenuItem key={session.id}>
        <SidebarMenuButton
          isActive={session.id === activeSessionId}
          className={cn(
            "h-auto py-1.5 transition-all duration-300",
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
          <div className="flex flex-col items-start gap-0.5 flex-1 min-w-0">
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
                      NEW
                    </span>
                  )}
                </>
              )}
            </div>
            {!isRenaming && (
              <div className="flex items-center gap-1.5 w-full">
                <span className="text-[10px] text-muted-foreground">
                  {formatDate(session.updatedAt)}
                  {session.messageCount !== undefined && (
                    <> · {session.messageCount} messages</>
                  )}
                </span>
                {session.id === activeSessionId && (
                  <span className="ml-auto">
                    <SidebarSessionStatusIndicator />
                  </span>
                )}
              </div>
            )}
          </div>
        </SidebarMenuButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 bottom-1 h-5 w-5 opacity-0 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 transition-opacity hover:bg-black/10 dark:hover:bg-white/10 rounded-md"
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
          className="flex-row items-center px-2 pt-1 pb-2"
          data-tauri-drag-region
        >
          <TrafficLights />
          {/* Flexible drag region */}
          <div className="flex-1" data-tauri-drag-region />
          {/* Icon group: workspace shell keeps only collapse in the header */}
          {isWorkspaceUIVariant() ? <SidebarCollapseToggle /> : <SidebarIconGroup />}
        </SidebarHeader>

        <SidebarContent>
          {isWorkspaceUIVariant() && (
            <div className="px-1.5 pb-0 pt-0">
              <div className="flex flex-col gap-0.5">
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-9 justify-start gap-2 px-1.5 font-normal",
                  shortcutsStripActive && "bg-primary/10 text-primary font-medium"
                )}
                onClick={handleWorkspaceShortcutsPanel}
              >
                <Bookmark
                  className={cn(
                    "h-4 w-4 shrink-0",
                    shortcutsStripActive ? "text-amber-500" : "text-muted-foreground"
                  )}
                />
                <span className="truncate text-sm">
                  {t("navigation.shortcuts", "Shortcuts")}
                </span>
              </Button>
              {WORKSPACE_QUICK_SECTIONS.map(({ id, labelKey, fallback, icon: Icon, color }) => {
                const isActive = embeddedSettingsSection === id
                return (
                  <Button
                    key={id}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "h-9 justify-start gap-2 px-1.5 font-normal",
                      isActive && "bg-primary/10 text-primary font-medium"
                    )}
                    onClick={() => handleOpenEmbeddedSection(id)}
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", isActive ? color : "text-muted-foreground")} />
                    <span className="truncate text-sm">{t(labelKey, fallback)}</span>
                  </Button>
                )
              })}
            </div>
            {/* Inset rule (not edge-to-edge) */}
            <div
              className="mx-3 mt-2 h-px shrink-0 bg-border/60"
              aria-hidden
            />
          </div>
          )}
          <SidebarGroup
            className={cn(
              "min-h-0 flex-1",
              isWorkspaceUIVariant() ? "!px-1 !pb-2 !pt-1" : "!px-0 !pb-0 !pt-0",
            )}
          >
            {isWorkspaceUIVariant() && (
              <div className="flex w-full shrink-0 flex-col pb-3 pt-0.5">
                <SidebarSecondarySessionActions
                  newChatVariant="sidebarWide"
                  includeSearchDialog={sidebarDisplayState !== 'collapsed'}
                />
              </div>
            )}

            {defaultSidebarContent === 'session' && (
              <>
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
              </>
            )}

            {defaultSidebarContent === 'knowledge' && (
              <div className="min-h-0 flex-1 overflow-hidden border-t border-border/60">
                <RightPanel defaultTab="knowledge" />
              </div>
            )}

            {defaultSidebarContent === 'shortcuts' && (
              <div className="min-h-0 flex-1 overflow-hidden border-t border-border/60">
                <ShortcutsPanel />
              </div>
            )}
          </SidebarGroup>

        </SidebarContent>

        <SidebarFooter className="gap-1 px-3 pb-4 pt-2">
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
              <div className="flex items-center gap-0.5">
                <WorkspaceSelectorButton />
                <OpenInNewWindowButton />
              </div>
            </div>
          )}

        </SidebarFooter>
      </div>
    </Sidebar>
  )
}
