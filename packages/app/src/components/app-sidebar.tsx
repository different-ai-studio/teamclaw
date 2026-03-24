import * as React from "react"
import { useTranslation } from "react-i18next"
import { Search, SquarePen, MessageSquare, Loader2, Archive, PanelLeftIcon, FolderOpen, Users, Pencil, Ellipsis, Clock } from "lucide-react"

import { useSessionStore } from "@/stores/session"
import { useStreamingStore } from "@/stores/streaming"
import { useUIStore } from "@/stores/ui"
import { useWorkspaceStore } from "@/stores/workspace"
import { useTabsStore } from "@/stores/tabs"
import { useCronStore } from "@/stores/cron"
import { useTeamModeStore } from "@/stores/team-mode"
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
import { formatSessionDate } from "@/lib/date-format"
import { Button } from "@/components/ui/button"
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

// Status indicator for the active session in the sidebar
function SidebarSessionStatusIndicator() {
  const sessionStatus = useSessionStore(s => s.sessionStatus)
  const pendingPermission = useSessionStore(s => s.pendingPermission)
  const pendingQuestion = useSessionStore(s => s.pendingQuestion)
  const streamingMessageId = useStreamingStore(s => s.streamingMessageId)

  if (pendingPermission || pendingQuestion) {
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
  const setActiveSession = useSessionStore(s => s.setActiveSession)
  const clearSelection = useWorkspaceStore(s => s.clearSelection)
  const closeSettings = useUIStore(s => s.closeSettings)

  // Format date for display
  const formatDate = (date: Date) => formatSessionDate(date)

  const handleSelectSession = async (sessionId: string) => {
    clearSelection()
    closeSettings()
    useTabsStore.getState().hideAll()
    await setActiveSession(sessionId)
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

// Exported icon group component for use in both sidebar and main content
export function SidebarIconGroup({ className }: { className?: string }) {
  const { t } = useTranslation()
  const { toggleSidebar } = useSidebar()
  const createSession = useSessionStore(s => s.createSession)
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const showCronSessions = useCronStore(s => s.showCronSessions)
  const toggleShowCronSessions = useCronStore(s => s.toggleShowCronSessions)
  const [isCreating, setIsCreating] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)
  
  const hasWorkspace = !!workspacePath

  // Keyboard shortcut: Cmd+K / Ctrl+K to open search
  React.useEffect(() => {
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
  }, [hasWorkspace])

  const handleNewSession = async () => {
    if (!hasWorkspace) return
    setIsCreating(true)
    try {
      useTabsStore.getState().hideAll()
      await createSession()
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <>
      <SessionSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <div className={`flex items-center gap-0.5 ${className || ''}`}>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={toggleSidebar}
        >
          <PanelLeftIcon className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-40"
          disabled={!hasWorkspace}
          onClick={() => setSearchOpen(true)}
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
          <Clock className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-40"
          onClick={handleNewSession}
          disabled={isCreating || !hasWorkspace}
          title={hasWorkspace ? t('chat.newChat', 'New Chat') : t('sidebar.selectWorkspaceFirst', 'Please select a workspace first')}
        >
          {isCreating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <SquarePen className="h-4 w-4" />
          )}
        </Button>
      </div>
    </>
  )
}

// Workspace selector button for sidebar footer
function WorkspaceSelectorButton() {
  const { t } = useTranslation()
  const workspaceName = useWorkspaceStore(s => s.workspaceName)
  const isLoadingWorkspace = useWorkspaceStore(s => s.isLoadingWorkspace)
  const setWorkspace = useWorkspaceStore(s => s.setWorkspace)
  const teamMode = useTeamModeStore(s => s.teamMode)
  const p2pConnected = useTeamModeStore(s => s.p2pConnected)
  const [isSelecting, setIsSelecting] = React.useState(false)

  // Poll P2P connection status when in team mode
  React.useEffect(() => {
    if (!teamMode || !isTauri()) return
    let cancelled = false
    const poll = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const status = await invoke<{ connected?: boolean }>('p2p_sync_status')
        if (!cancelled) useTeamModeStore.setState({ p2pConnected: status?.connected ?? false })
      } catch { /* ignore */ }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [teamMode])

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

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground max-w-[180px]"
          disabled={isLoading}
          onClick={handleOpenFolder}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          ) : teamMode && workspaceName ? (
            <Users className={cn("h-4 w-4 shrink-0", p2pConnected ? "text-blue-500" : "text-muted-foreground")} />
          ) : (
            <FolderOpen className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate text-xs" data-testid="workspace-name">
            {workspaceName || t('workspace.selectWorkspace', 'Select Workspace')}
          </span>
          {teamMode && workspaceName && (
            <span className={cn(
              "shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded flex items-center gap-1",
              p2pConnected
                ? "text-green-600 dark:text-green-400 bg-green-500/10"
                : "text-amber-600 dark:text-amber-400 bg-amber-500/10"
            )}>
              <span className={cn("h-1.5 w-1.5 rounded-full", p2pConnected ? "bg-green-500" : "bg-amber-500")} />
              {t('sidebar.teamTag', 'Team')}
            </span>
          )}
        </Button>
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
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const isLoading = useSessionStore(s => s.isLoading)
  const isLoadingMore = useSessionStore(s => s.isLoadingMore)
  const hasMoreSessions = useSessionStore(s => s.hasMoreSessions)
  const visibleSessionCount = useSessionStore(s => s.visibleSessionCount)
  const highlightedSessionIds = useSessionStore(s => s.highlightedSessionIds)
  const setActiveSession = useSessionStore(s => s.setActiveSession)
  const archiveSession = useSessionStore(s => s.archiveSession)
  const updateSessionTitle = useSessionStore(s => s.updateSessionTitle)
  const loadMoreSessions = useSessionStore(s => s.loadMoreSessions)
  const cronSessionIds = useCronStore(s => s.cronSessionIds)
  const showCronSessions = useCronStore(s => s.showCronSessions)

  // Rename state
  const [renamingSessionId, setRenamingSessionId] = React.useState<string | null>(null)

  // UI-level pagination: filter by cron toggle, then slice to visible count
  const sessions = React.useMemo(
    () => allSessions
      .filter(s => showCronSessions
        ? cronSessionIds.has(s.id)
        : !cronSessionIds.has(s.id) || s.id === activeSessionId
      )
      .slice(0, visibleSessionCount),
    [allSessions, cronSessionIds, showCronSessions, activeSessionId, visibleSessionCount],
  )
  
  const openSettings = useUIStore(s => s.openSettings)
  const closeSettings = useUIStore(s => s.closeSettings)
  const clearSelection = useWorkspaceStore(s => s.clearSelection)

  const handleSelectSession = async (id: string) => {
    // Close any open file editor and return to chat view
    clearSelection()
    // Close settings page if open
    closeSettings()
    // Hide any open tabs (webview/file) to reveal the conversation
    useTabsStore.getState().hideAll()

    if (id !== activeSessionId) {
      await setActiveSession(id)
    }
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

  // Format date for display
  const formatDate = (date: Date) => {
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    
    if (days === 0) return t('sidebar.today', 'Today')
    if (days === 1) return t('sidebar.yesterday', 'Yesterday')
    if (days < 7) return `${days} days ago`
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  return (
    <Sidebar variant="floating" {...props}>
      {/* Header: custom traffic lights (Tauri) or spacer + icon group */}
      <SidebarHeader 
        className="flex-row items-center px-2 pt-1 pb-2"
        data-tauri-drag-region
      >
        <TrafficLights />
        {/* Flexible drag region */}
        <div className="flex-1" data-tauri-drag-region />
        {/* Icon group - shows in sidebar when expanded */}
        <SidebarIconGroup />
      </SidebarHeader>
      
      <SidebarContent>
        <SidebarGroup>
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
              sessions.map((session) => {
                const isHighlighted = highlightedSessionIds.includes(session.id)
                const isRenaming = renamingSessionId === session.id
                return (
                <SidebarMenuItem key={session.id}>
                  <SidebarMenuButton
                    isActive={session.id === activeSessionId}
                    className={cn(
                      "h-auto py-2 transition-all duration-300",
                      isHighlighted && "bg-emerald-500/15 ring-1 ring-emerald-500/30"
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
                            <span className="truncate text-left">
                              {session.title}
                            </span>
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
              })
            )}
          </SidebarMenu>
          
          {/* Load More button */}
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
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-3 py-3">
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => openSettings()}
          >
            {t('sidebar.settings', '设置')}
          </Button>
          <WorkspaceSelectorButton />
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
