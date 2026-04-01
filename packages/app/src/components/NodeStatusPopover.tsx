import * as React from "react"
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

function connectionLabel(connection: PeerConnection, lastSeenSecsAgo: number): string {
  switch (connection) {
    case "active":
      return "Online"
    case "stale": {
      if (lastSeenSecsAgo < 60) return `Stale ${lastSeenSecsAgo}s`
      const mins = Math.floor(lastSeenSecsAgo / 60)
      return `Stale ${mins}m`
    }
    case "lost": {
      if (lastSeenSecsAgo < 60) return `Offline ${lastSeenSecsAgo}s`
      const mins = Math.floor(lastSeenSecsAgo / 60)
      if (mins < 60) return `Offline ${mins}m`
      const hrs = Math.floor(mins / 60)
      return `Offline ${hrs}h`
    }
    case "unknown":
    default:
      return "Unknown"
  }
}

function formatLastSync(iso: string | null): string {
  if (!iso) return "Never"
  const date = new Date(iso)
  const secsAgo = Math.floor((Date.now() - date.getTime()) / 1000)
  if (secsAgo < 5) return "Just now"
  if (secsAgo < 60) return `${secsAgo}s ago`
  const mins = Math.floor(secsAgo / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
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
  const dotColor = isLocal ? "bg-blue-500" : connectionDot(connection)
  const label = isLocal ? "This device" : connectionLabel(connection, lastSeenSecsAgo)
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
  const snapshot = useP2pEngineStore((s) => s.snapshot)
  const fetchSnapshot = useP2pEngineStore((s) => s.fetch)
  const members = useTeamMembersStore((s) => s.members)
  const [open, setOpen] = React.useState(false)
  const [currentNodeId, setCurrentNodeId] = React.useState<string | null>(null)
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<{ nodeId: string }>("get_device_info")
        .then((info) => { if (!cancelled) setCurrentNodeId(info.nodeId) })
        .catch(() => {})
    )
    return () => { cancelled = true }
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
    ? "Connected"
    : isDegraded
    ? "Degraded"
    : isReconnecting
    ? "Reconnecting..."
    : "Disconnected"

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
              Engine: {streamHealth}
            </p>
            {restartCount > 0 && (
              <p className="text-[10px] text-muted-foreground">
                Restarts: {restartCount}
              </p>
            )}
          </div>
        )}

        {/* ── Stats ── */}
        <div className="space-y-1 mb-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Last sync</span>
            <span className="text-[10px] text-foreground">{formatLastSync(lastSyncAt)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Synced files</span>
            <span className="text-[10px] text-foreground">{syncedFiles}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Pending files</span>
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
              Team Members ({sortedRows.length})
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
