import * as React from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { useP2pEngineStore, type PeerConnection } from "@/stores/p2p-engine"
import { useTeamMembersStore } from "@/stores/team-members"
import { cn, isTauri } from "@/lib/utils"

// ─── Helper functions ────────────────────────────────────────────────────────

function connectionDot(connection: PeerConnection): string {
  switch (connection) {
    case "active":
      return "bg-emerald-500"
    case "stale":
      return "bg-amber-500"
    case "lost":
      return "bg-red-500"
    case "unknown":
    default:
      return "bg-muted-foreground/40"
  }
}

function connectionLabel(connection: PeerConnection, lastSeenSecsAgo: number, t: TFunction): string {
  switch (connection) {
    case "active":
      return t("nodeStatus.online", "Online")
    case "stale": {
      if (lastSeenSecsAgo < 60) return t("nodeStatus.staleSeconds", { count: lastSeenSecsAgo })
      const mins = Math.floor(lastSeenSecsAgo / 60)
      return t("nodeStatus.staleMinutes", { count: mins })
    }
    case "lost": {
      if (lastSeenSecsAgo < 60) return t("nodeStatus.offlineSeconds", { count: lastSeenSecsAgo })
      const mins = Math.floor(lastSeenSecsAgo / 60)
      if (mins < 60) return t("nodeStatus.offlineMinutes", { count: mins })
      const hrs = Math.floor(mins / 60)
      return t("nodeStatus.offlineHours", { count: hrs })
    }
    case "unknown":
    default:
      return t("nodeStatus.unknown", "Unknown")
  }
}

function formatLastSync(iso: string | null, t: TFunction): string {
  if (!iso) return t("common.never", "Never")
  const date = new Date(iso)
  const secsAgo = Math.floor((Date.now() - date.getTime()) / 1000)
  if (secsAgo < 5) return t("common.justNow", "Just now")
  if (secsAgo < 60) return t("nodeStatus.secondsAgo", { count: secsAgo })
  const mins = Math.floor(secsAgo / 60)
  if (mins < 60) return t("nodeStatus.minutesAgoShort", { count: mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return t("nodeStatus.hoursAgoShort", { count: hrs })
  const days = Math.floor(hrs / 24)
  return t("nodeStatus.daysAgoShort", { count: days })
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusDot({ className }: { className: string }) {
  return (
    <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", className)} />
  )
}

interface MemberRowProps {
  name: string
  role: string
  isLocal: boolean
  connection: PeerConnection
  lastSeenSecsAgo: number
}

function MemberRow({ name, role, isLocal, connection, lastSeenSecsAgo }: MemberRowProps) {
  const { t } = useTranslation()
  const dotColor = isLocal ? "bg-blue-500" : connectionDot(connection)
  const label = isLocal ? t("nodeStatus.thisDevice", "This device") : connectionLabel(connection, lastSeenSecsAgo, t)
  const labelColor = isLocal
    ? "text-blue-500"
    : connection === "active"
    ? "text-emerald-500"
    : connection === "stale"
    ? "text-amber-500"
    : connection === "lost"
    ? "text-red-500"
    : "text-muted-foreground"

  return (
    <div className="flex items-center gap-2 py-0.5">
      <StatusDot className={dotColor} />
      <span className="flex-1 min-w-0 truncate text-xs text-foreground">
        {name}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground capitalize">
        {role}
      </span>
      <span className={cn("shrink-0 text-[10px]", labelColor)}>
        {label}
      </span>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function NodeStatusPopover({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const snapshot = useP2pEngineStore((s) => s.snapshot)
  const fetchSnapshot = useP2pEngineStore((s) => s.fetch)
  const members = useTeamMembersStore((s) => s.members)
  const currentNodeId = useTeamMembersStore((s) => s.currentNodeId)
  const loadCurrentNodeId = useTeamMembersStore((s) => s.loadCurrentNodeId)
  const [open, setOpen] = React.useState(false)
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    if (!isTauri()) return
    loadCurrentNodeId()
  }, [])

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 200)
  }

  const handleTriggerEnter = () => {
    cancelClose()
    void fetchSnapshot()
    setOpen(true)
  }

  // Derive display status
  const { status, streamHealth, restartCount, lastSyncAt, peers, syncedFiles, pendingFiles } =
    snapshot

  const isHealthy = status === "connected" && streamHealth === "healthy"
  const isDegraded = status === "connected" && streamHealth !== "healthy"
  const isReconnecting = status === "reconnecting"
  const statusDotColor = isHealthy
    ? "bg-emerald-500"
    : isDegraded || isReconnecting
    ? "bg-amber-500"
    : "bg-red-500"

  const statusLabel = isHealthy
    ? t("nodeStatus.connected", "Connected")
    : isDegraded
    ? t("nodeStatus.degraded", "Degraded")
    : isReconnecting
    ? t("nodeStatus.reconnecting", "Reconnecting...")
    : t("nodeStatus.disconnected", "Disconnected")

  const showEngineInfo = !isHealthy && streamHealth !== "healthy"

  const memberRows = React.useMemo(() => {
    if (members.length > 0) {
      return members.map((m) => {
        const isLocal = m.nodeId === currentNodeId
        const peer = peers.find((p) => p.nodeId === m.nodeId)
        return {
          key: m.nodeId,
          name: m.name || m.hostname || m.nodeId.slice(0, 8) + "…",
          role: m.role || "editor",
          isLocal,
          connection: (peer?.connection ?? "unknown") as PeerConnection,
          lastSeenSecsAgo: peer?.lastSeenSecsAgo ?? 0,
        }
      })
    }

    return peers.map((peer) => ({
      key: peer.nodeId,
      name: peer.name || peer.nodeId.slice(0, 8) + "…",
      role: peer.role,
      isLocal: peer.nodeId === currentNodeId,
      connection: peer.connection,
      lastSeenSecsAgo: peer.lastSeenSecsAgo,
    }))
  }, [members, peers, currentNodeId])

  const sortedRows = React.useMemo(() => {
    const roleOrder: Record<string, number> = { owner: 0, editor: 1, viewer: 2 }
    return [...memberRows].sort((a, b) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1
      const ra = roleOrder[a.role] ?? 3
      const rb = roleOrder[b.role] ?? 3
      if (ra !== rb) return ra - rb
      return a.name.localeCompare(b.name)
    })
  }, [memberRows])

  return (
    <Popover open={open} onOpenChange={() => {}}>
      <PopoverTrigger asChild>
        <span
          className="inline-flex"
          onMouseEnter={handleTriggerEnter}
          onMouseLeave={scheduleClose}
        >
          {children}
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={8}
        className="w-72 p-3 bg-card text-card-foreground"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {/* ── Header ── */}
        <div className="flex items-center gap-2 mb-2">
          <StatusDot className={statusDotColor} />
          <span className="text-xs font-medium">{statusLabel}</span>
        </div>

        {showEngineInfo && (
          <div className="mb-2 space-y-0.5">
            <p className="text-[10px] text-muted-foreground">
              {t("nodeStatus.engine", "Engine")}: {streamHealth}
            </p>
            {restartCount > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {t("nodeStatus.restarts", "Restarts")}: {restartCount}
              </p>
            )}
          </div>
        )}

        {/* ── Stats ── */}
        <div className="space-y-1 mb-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">{t("nodeStatus.lastSync", "Last sync")}</span>
            <span className="text-[10px] text-foreground">{formatLastSync(lastSyncAt, t)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">{t("nodeStatus.syncedFiles", "Synced files")}</span>
            <span className="text-[10px] text-foreground">{syncedFiles}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">{t("nodeStatus.pendingFiles", "Pending files")}</span>
            <span
              className={cn(
                "text-[10px]",
                pendingFiles > 0 ? "text-amber-500" : "text-foreground"
              )}
            >
              {pendingFiles}
            </span>
          </div>
        </div>

        {/* ── Members ── */}
        {sortedRows.length > 0 && (
          <>
            <Separator className="my-2" />
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              {t("nodeStatus.teamMembers", { count: sortedRows.length })}
            </p>
            <div className="space-y-0.5">
              {sortedRows.map((row) => (
                <MemberRow
                  key={row.key}
                  name={row.name}
                  role={row.role}
                  isLocal={row.isLocal}
                  connection={row.connection}
                  lastSeenSecsAgo={row.lastSeenSecsAgo}
                />
              ))}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
