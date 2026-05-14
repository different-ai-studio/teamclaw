import * as React from "react"
import { useTranslation } from "react-i18next"
import { Archive, Loader2, MessageSquare } from "lucide-react"

import { useSessionStore } from "@/stores/session"
import type { Session } from "@/stores/session"
import { useUIStore } from "@/stores/ui"
import { useWorkspaceStore } from "@/stores/workspace"
import { formatRelativeTime } from "@/lib/date-format"
import { Button } from "@/components/ui/button"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"

export type SessionSearchFilter = "active" | "archived" | "all"

// Session search dialog component
export function SessionSearchDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const sessions = useSessionStore(s => s.sessions)
  const archivedSessions = useSessionStore(s => s.archivedSessions)
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const isLoadingArchivedSessions = useSessionStore(s => s.isLoadingArchivedSessions)
  const archivedSessionError = useSessionStore(s => s.archivedSessionError)
  const loadArchivedSessions = useSessionStore(s => s.loadArchivedSessions)
  const openArchivedSession = useSessionStore(s => s.openArchivedSession)
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const [filter, setFilter] = React.useState<SessionSearchFilter>("active")

  // Format date for display
  const formatDate = (date: Date) => formatRelativeTime(date)

  React.useEffect(() => {
    if (open) setFilter("active")
  }, [open])

  React.useEffect(() => {
    if (!open || filter === "active") return
    void loadArchivedSessions(workspacePath || undefined)
  }, [filter, loadArchivedSessions, open, workspacePath])

  const handleSelectSession = (sessionId: string) => {
    useUIStore.getState().switchToSession(sessionId)
    onOpenChange(false)
  }

  const handleSelectArchivedSession = (sessionId: string) => {
    onOpenChange(false)
    void openArchivedSession(sessionId)
  }

  const activeResults = sessions.map((session) => ({ session, isArchived: false }))
  const archivedResults = archivedSessions.map((session) => ({ session, isArchived: true }))
  const visibleSessions: { session: Session; isArchived: boolean }[] =
    filter === "active"
      ? activeResults
      : filter === "archived"
        ? archivedResults
        : [...activeResults, ...archivedResults]

  const showArchivedStatus = filter === "archived" || filter === "all"
  const filterOptions: { value: SessionSearchFilter; label: string }[] = [
    { value: "active", label: t("sidebar.searchActive", "Active") },
    { value: "archived", label: t("sidebar.searchArchived", "Archived") },
    { value: "all", label: t("sidebar.searchAll", "All") },
  ]

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('sidebar.searchSessions', 'Search Sessions')}
      description={t('sidebar.searchDescription', 'Search and navigate to a session')}
    >
      <CommandInput placeholder={t('sidebar.searchPlaceholder', 'Search sessions...')} />
      <div className="flex items-center gap-1 border-b px-3 py-2">
        {filterOptions.map((option) => (
          <Button
            key={option.value}
            type="button"
            variant={filter === option.value ? "secondary" : "ghost"}
            size="sm"
            className="h-7 rounded-md px-2.5 text-xs"
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <CommandList className="max-h-[400px]">
        <CommandEmpty>{t('sidebar.noSessionsFound', 'No sessions found.')}</CommandEmpty>
        {showArchivedStatus && isLoadingArchivedSessions && (
          <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("sidebar.loadingArchivedSessions", "Loading archived sessions...")}
          </div>
        )}
        {showArchivedStatus && archivedSessionError && (
          <div className="px-3 py-2 text-sm text-destructive">
            {archivedSessionError}
          </div>
        )}
        <CommandGroup heading={t('sidebar.sessions', 'Sessions')}>
          {visibleSessions.map(({ session, isArchived }) => (
            <CommandItem
              key={`${isArchived ? "archived" : "active"}-${session.id}`}
              value={`${session.id} ${session.title}`}
              onSelect={() => {
                if (isArchived) {
                  void handleSelectArchivedSession(session.id)
                } else {
                  handleSelectSession(session.id)
                }
              }}
            >
              {isArchived ? (
                <Archive className="h-4 w-4 mr-3 text-muted-foreground shrink-0" />
              ) : (
                <MessageSquare className="h-4 w-4 mr-3 text-muted-foreground shrink-0" />
              )}
              <div className="flex flex-col flex-1 min-w-0">
                <span className="truncate font-medium">{session.title}</span>
                <span className="text-xs text-muted-foreground">
                  {isArchived && session.archivedAt
                    ? t("sidebar.archivedAt", "Archived {{date}}", { date: formatDate(session.archivedAt) })
                    : formatDate(session.updatedAt)}
                </span>
              </div>
              {isArchived ? (
                <span className="text-xs text-muted-foreground font-medium ml-2 shrink-0">
                  {t("sidebar.searchArchived", "Archived")}
                </span>
              ) : activeSessionId === session.id && (
                <span className="text-xs text-emerald-500 font-medium ml-2 shrink-0">{t('sidebar.active', 'Active')}</span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
