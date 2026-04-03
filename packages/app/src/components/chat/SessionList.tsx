import React, { useCallback, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MessageSquare, Loader2 } from 'lucide-react'
import { useSessionStore } from '@/stores/session'
import { useStreamingStore } from '@/stores/streaming'
import { useWorkspaceStore } from '@/stores/workspace'
import { useUIStore } from '@/stores/ui'
import { useCronStore } from '@/stores/cron'
import { cn } from '@/lib/utils'
import { formatRelativeDate } from '@/lib/date-format'

interface SessionListProps {
  compact?: boolean
  onSessionSelected?: () => void
}

// ── Memoized session item to prevent re-rendering all items on single change ──

interface SessionListItemProps {
  session: { id: string; title: string; updatedAt: string | Date; messageCount?: number }
  isActive: boolean
  isHighlighted: boolean
  compact?: boolean
  onSelect: (id: string) => void
}

// Extracted sub-component: only rendered when isActive, so non-active items
// don't subscribe to sessionStatus/streamingMessageId stores (keeps memo stable).
function SessionStatusIndicator({ compact }: { compact?: boolean }) {
  const sessionStatus = useSessionStore(s => s.sessionStatus)
  const pendingPermission = useSessionStore(s => s.pendingPermission)
  const pendingQuestion = useSessionStore(s => s.pendingQuestion)
  const streamingMessageId = useStreamingStore(s => s.streamingMessageId)

  if (pendingPermission || pendingQuestion) {
    return (
      <span className="shrink-0 text-[10px] font-medium text-emerald-600 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">
        等待确认
      </span>
    )
  }

  // Both checks needed: sessionStatus covers pre-streaming busy (tool exec),
  // streamingMessageId covers streaming when status may lag
  if (sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry' || streamingMessageId) {
    return (
      <Loader2 className={cn(
        "shrink-0 animate-spin text-muted-foreground/70",
        compact ? "h-3 w-3" : "h-3.5 w-3.5"
      )} />
    )
  }

  return null
}

const SessionListItem = React.memo(function SessionListItem({
  session,
  isActive,
  isHighlighted,
  compact,
  onSelect,
}: SessionListItemProps) {
  return (
    <button
      onClick={() => onSelect(session.id)}
      className={cn(
        "w-full text-left rounded-lg transition-all duration-200 group",
        compact ? "px-3 py-2" : "px-3 py-2.5",
        isHighlighted
          ? "bg-emerald-500/10 ring-1 ring-emerald-500/25 text-foreground"
          : isActive
            ? "bg-primary/8 text-foreground"
            : "hover:bg-muted/60 text-muted-foreground hover:text-foreground"
      )}
    >
      <div className="flex items-start gap-2.5 min-w-0">
        <MessageSquare className={cn(
          "shrink-0 mt-0.5",
          compact ? "h-3.5 w-3.5" : "h-4 w-4",
          isActive ? "text-primary" : "text-muted-foreground/50 group-hover:text-muted-foreground/70",
        )} />
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn(
              "truncate leading-snug",
              compact ? "text-sm" : "text-[15px]",
              isActive && "font-medium",
            )}>
              {session.title}
            </span>
            {isActive ? (
              <SessionStatusIndicator compact={compact} />
            ) : isHighlighted ? (
              <span className="shrink-0 text-[10px] font-medium text-emerald-600 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">
                NEW
              </span>
            ) : null}
          </div>
          <span className={cn("text-muted-foreground/70", compact ? "text-xs" : "text-xs")}>
            {formatRelativeDate(session.updatedAt)}
            {session.messageCount !== undefined && (
              <> · {session.messageCount} msgs</>
            )}
          </span>
        </div>
      </div>
    </button>
  )
})

// ── Virtualization constants ──
const VIRTUAL_THRESHOLD = 50
const ROW_HEIGHT = 52
const ROW_HEIGHT_COMPACT = 40

export function SessionList({ compact, onSessionSelected }: SessionListProps) {
  const allSessions = useSessionStore(s => s.sessions)
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const cronSessionIds = useCronStore(s => s.cronSessionIds)
  const showCronSessions = useCronStore(s => s.showCronSessions)

  // Filter sessions by cron toggle
  const sessions = useMemo(
    () => allSessions.filter(s => showCronSessions
      ? cronSessionIds.has(s.id)
      : !cronSessionIds.has(s.id) || s.id === activeSessionId
    ),
    [allSessions, cronSessionIds, showCronSessions, activeSessionId],
  )
  const isLoading = useSessionStore(s => s.isLoading)
  const highlightedSessionIds = useSessionStore(s => s.highlightedSessionIds)
  const setActiveSession = useSessionStore(s => s.setActiveSession)
  const clearSelection = useWorkspaceStore(s => s.clearSelection)
  const setFileModeRightTab = useUIStore(s => s.setFileModeRightTab)

  const parentRef = useRef<HTMLDivElement>(null)
  const useVirtual = sessions.length > VIRTUAL_THRESHOLD
  const rowHeight = compact ? ROW_HEIGHT_COMPACT : ROW_HEIGHT

  const virtualizer = useVirtualizer({
    count: useVirtual ? sessions.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  })

  // Keep selection hooks wired for future multi-select UX without changing current behavior
  void setActiveSession
  void clearSelection

  const handleSelectSession = useCallback((id: string) => {
    useUIStore.getState().switchToSession(id)
    if (useUIStore.getState().layoutMode === 'file') {
      setFileModeRightTab('agent')
    }
    onSessionSelected?.()
  }, [setFileModeRightTab, onSessionSelected])

  if (isLoading && sessions.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className={cn("animate-spin text-muted-foreground", compact ? "h-4 w-4" : "h-5 w-5")} />
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className={cn("flex flex-col items-center justify-center text-center", compact ? "py-8" : "py-12")}>
        <div className={cn("rounded-full bg-muted/50 mb-3", compact ? "p-2.5" : "p-3")}>
          <MessageSquare className={cn("text-muted-foreground/60", compact ? "h-5 w-5" : "h-6 w-6")} />
        </div>
        <p className={cn("text-muted-foreground/70 font-medium", compact ? "text-xs" : "text-sm")}>
          No conversations yet
        </p>
      </div>
    )
  }

  // Virtualized rendering for large session lists
  if (useVirtual) {
    return (
      <div
        ref={parentRef}
        className={cn("overflow-auto", compact ? "p-1" : "p-2")}
        style={{ height: '100%' }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: 'relative',
            width: '100%',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const session = sessions[virtualItem.index]
            return (
              <div
                key={session.id}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <SessionListItem
                  session={session}
                  isActive={session.id === activeSessionId}
                  isHighlighted={highlightedSessionIds.includes(session.id)}
                  compact={compact}
                  onSelect={handleSelectSession}
                />
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Non-virtualized rendering for small lists
  return (
    <div className={cn("space-y-0.5", compact ? "p-1.5" : "p-2")}>
      {sessions.map((session) => (
        <SessionListItem
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          isHighlighted={highlightedSessionIds.includes(session.id)}
          compact={compact}
          onSelect={handleSelectSession}
        />
      ))}
    </div>
  )
}
