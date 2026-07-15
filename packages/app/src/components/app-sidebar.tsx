import * as React from "react"
import { useTranslation } from "react-i18next"
import { Search, SquarePen, PanelLeftIcon, Settings, ChevronUp, Mail, CalendarDays, LogOut, Users, Trophy, Sparkles } from "lucide-react"
import { useTeamShareStore, isShareModeLocked } from "@/stores/team-share"
import { UpgradeAccountDialog } from "@/components/auth/UpgradeAccountDialog"

import { useSessionStore } from "@/stores/session"
import { useStreamingStore } from "@/stores/streaming"
import { useUIStore } from "@/stores/ui"
import { useWorkspaceStore } from "@/stores/workspace"
import { useCronStore } from "@/stores/cron"
import { useAuthStore } from "@/stores/auth-store"
import { useCurrentTeamStore } from "@/stores/current-team"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { AnimatedClock } from "@/components/ui/animated-clock"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TrafficLights } from "@/components/ui/traffic-lights"
import { buildSessionListActivityMap } from "@/lib/session-list-activity"
import { SessionSearchDialog } from "@/components/sidebar/session-search-dialog"
import { SessionDetailDialog, type SessionDetailListHints } from "@/components/sidebar/SessionDetailDialog"
import { NavRail } from "@/components/sidebar/NavRail"
import { LocalDaemonCard } from "@/components/sidebar/LocalDaemonCard"
import { MqttDisconnectedNotice } from "@/components/sidebar/MqttDisconnectedNotice"

/** Sidebar collapse control only (workspace variant sidebar header). */
export function SidebarCollapseToggle({ className }: { className?: string }) {
  const { t } = useTranslation()
  const { toggleSidebar } = useSidebar()
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7 text-muted-foreground hover:text-foreground", className)}
      onClick={toggleSidebar}
      title={t("navigation.collapseSidebar", "Collapse sidebar")}
      aria-label={t("navigation.collapseSidebar", "Collapse sidebar")}
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
    "h-7 w-7 shrink-0 rounded-lg border border-secondary !bg-sidebar p-0 font-normal shadow-none disabled:opacity-40 dark:!bg-sidebar"

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
            className="h-7 min-w-0 flex-1 justify-center gap-1.5 rounded-lg px-2.5 text-xs font-normal shadow-none disabled:opacity-40"
            onClick={handleNewSession}
            disabled={!hasWorkspace}
            title={hasWorkspace ? newChatLabel : t('sidebar.selectWorkspaceFirst', 'Please select a workspace first')}
          >
            <SquarePen className="h-3.5 w-3.5 shrink-0" />
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
                <Search className="h-3.5 w-3.5" />
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
                <AnimatedClock className="h-3.5 w-3.5" animate={showCronSessions} />
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

function SidebarUserAccountMenu() {
  const { t, i18n } = useTranslation()
  const authSession = useAuthStore((s) => s.session)
  const signOut = useAuthStore((s) => s.signOut)
  const currentTeam = useCurrentTeamStore((s) => s.team)
  const currentMember = useCurrentTeamStore((s) => s.currentMember)
  const teamShareActive = useTeamShareStore((s) => isShareModeLocked(s.status.mode))
  const openSettings = useUIStore((s) => s.openSettings)

  const [upgradeOpen, setUpgradeOpen] = React.useState(false)

  if (!authSession) return null

  const meta = authSession.user.user_metadata as Record<string, unknown> | undefined
  const avatarUrl = typeof meta?.avatar_url === 'string' ? meta.avatar_url : null
  const email = authSession.user.email || ""
  const isAnonymous = Boolean(authSession.user.isAnonymous)
  const fallbackName =
    (typeof meta?.full_name === 'string' && meta.full_name) ||
    (typeof meta?.name === 'string' && meta.name) ||
    (email ? email.split("@")[0] : "") ||
    t("common.user", "User")
  const userName = currentMember?.displayName || fallbackName
  const joinedAt = (() => {
    const value = currentMember?.joinedAt
    if (!value) return t("common.notAvailable", "Not available")
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return t("common.notAvailable", "Not available")
    return new Intl.DateTimeFormat(i18n?.language || undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date)
  })()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 shrink max-w-full gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          data-testid="sidebar-user-menu-trigger"
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-4 w-4 shrink-0 rounded-full object-cover" />
          ) : (
            <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-foreground">
              {(userName?.[0] || "?").toUpperCase()}
            </div>
          )}
          <span className="min-w-0 truncate">{userName}</span>
          <ChevronUp className="h-3.5 w-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-72 p-2">
        <DropdownMenuLabel className="px-2 py-1">
          <div className="truncate text-[13px] font-semibold text-foreground">{userName}</div>
          {currentMember?.role && (
            <div className="mt-0.5 font-mono text-[11px] font-normal text-muted-foreground">
              {currentMember.role}
            </div>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="space-y-1 px-2 py-1.5 text-[12px]">
          {isAnonymous ? (
            <button
              type="button"
              onClick={() => setUpgradeOpen(true)}
              className="flex w-full items-start gap-2 rounded-[8px] -mx-1 px-1 py-1 text-left transition-colors hover:bg-selected/45"
              data-testid="sidebar-upgrade-account"
            >
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-coral" />
              <div className="min-w-0">
                <div className="text-foreground font-medium">
                  {t("auth.upgrade.entry", "Upgrade account")}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {t("auth.upgrade.entryHint", "Bind an email to keep this workspace")}
                </div>
              </div>
            </button>
          ) : (
            <div className="flex items-start gap-2">
              <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-faint">{t("auth.email", "Email")}</div>
                <div className="truncate font-mono text-[11px] text-foreground">
                  {email || t("common.notAvailable", "Not available")}
                </div>
              </div>
            </div>
          )}
          <div className="flex items-start gap-2">
            <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-faint">{t("settings.team.teamName", "Team name")}</div>
              <div className="truncate text-foreground">
                {currentTeam?.name || t("common.notAvailable", "Not available")}
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <CalendarDays className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-faint">{t("settings.team.joinedAt", "Joined")}</div>
              <div className="font-mono text-[11px] text-foreground">{joinedAt}</div>
            </div>
          </div>
        </div>
        {teamShareActive && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => openSettings('leaderboard')}>
              <Trophy className="mr-2 h-4 w-4" />
              {t('settings.nav.leaderboard', 'Team Leaderboard')}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => { void signOut() }} variant="destructive">
          <LogOut className="mr-2 h-4 w-4" />
          {t('common.signOut', 'Sign out')}
        </DropdownMenuItem>
      </DropdownMenuContent>
      <UpgradeAccountDialog open={upgradeOpen} onOpenChange={setUpgradeOpen} />
    </DropdownMenu>
  )
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation()
  const allSessions = useSessionStore(s => s.sessions)
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const sessionStatuses = useSessionStore(s => s.sessionStatuses) || {}
  const pendingQuestionIdsBySession = useSessionStore(s => s.pendingQuestionIdsBySession) || {}
  const pendingQuestions = useSessionStore(s => s.pendingQuestions) || []
  const pendingPermissions = useSessionStore(s => s.pendingPermissions) || []
  const streamingMessageId = useStreamingStore(s => s.streamingMessageId)
  const childSessionStreaming = useStreamingStore(s => s.childSessionStreaming)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)

  const [detailSessionId, setDetailSessionId] = React.useState<string | null>(null)
  const [detailHints, setDetailHints] = React.useState<SessionDetailListHints | null>(null)

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

  const handleSelectSession = (id: string) => {
    useUIStore.getState().switchToSession(id)
  }

  return (
    <Sidebar variant="sidebar" {...props}>
      <SessionDetailDialog
        sessionId={detailSessionId}
        teamId={teamId}
        hints={detailHints}
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
      <div className="flex h-full flex-col">
        {/* Header: custom traffic lights (Tauri) or spacer + icon group */}
        <SidebarHeader
          className="flex-row items-center h-12 shrink-0 px-2 pt-0 pb-0"
          data-tauri-drag-region
        >
          <TrafficLights />
          {/* Flexible drag region */}
          <div className="flex-1" data-tauri-drag-region />
          <SidebarCollapseToggle />
        </SidebarHeader>

        <SidebarContent className="overflow-hidden">
          <NavRail />
        </SidebarContent>

        <SidebarFooter className="gap-1 px-2 pb-1 pt-1">
          <LocalDaemonCard />
          <MqttDisconnectedNotice />

            <div className="flex min-w-0 items-center justify-between gap-1 overflow-hidden">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => openSettings()}
              >
                <Settings className="h-3.5 w-3.5 shrink-0" />
                {t('common.settings', 'Settings')}
              </Button>
              <div className="min-w-0 overflow-hidden">
                <SidebarUserAccountMenu />
              </div>
            </div>

        </SidebarFooter>
      </div>
    </Sidebar>
  )
}
