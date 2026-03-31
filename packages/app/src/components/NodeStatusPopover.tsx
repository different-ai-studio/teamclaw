import * as React from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { useP2pEngineStore, PeerInfo, PeerConnection } from "@/stores/p2p-engine"
import { cn } from "@/lib/utils"

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
      return "Active"
    case "stale": {
      if (lastSeenSecsAgo < 60) return `Stale ${lastSeenSecsAgo}s`
      const mins = Math.floor(lastSeenSecsAgo / 60)
      return `Stale ${mins}m`
    }
    case "lost": {
      if (lastSeenSecsAgo < 60) return `Lost ${lastSeenSecsAgo}s`
      const mins = Math.floor(lastSeenSecsAgo / 60)
      if (mins < 60) return `Lost ${mins}m`
      const hrs = Math.floor(mins / 60)
      return `Lost ${hrs}h`
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

function PeerRow({ peer }: { peer: PeerInfo }) {
  const displayName = peer.name || peer.nodeId.slice(0, 8) + "…"
  const dotColor = connectionDot(peer.connection)
  const label = connectionLabel(peer.connection, peer.lastSeenSecsAgo)

  return (
    <div className="flex items-center gap-2 py-0.5">
      <StatusDot className={dotColor} />
      <span className="flex-1 min-w-0 truncate text-xs text-foreground">
        {displayName}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground capitalize">
        {peer.role}
      </span>
      <span
        className={cn(
          "shrink-0 text-[10px]",
          peer.connection === "active"
            ? "text-emerald-500"
            : peer.connection === "stale"
            ? "text-amber-500"
            : peer.connection === "lost"
            ? "text-red-500"
            : "text-muted-foreground"
        )}
      >
        {label}
      </span>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function NodeStatusPopover({ children }: { children: React.ReactNode }) {
  const snapshot = useP2pEngineStore((s) => s.snapshot)
  const fetchSnapshot = useP2pEngineStore((s) => s.fetch)

  const handleMouseEnter = () => {
    void fetchSnapshot()
  }

  // Derive display status
  const { status, streamHealth, restartCount, lastSyncAt, peers, syncedFiles, pendingFiles } =
    snapshot

  const isHealthy = status === "connected" && streamHealth === "healthy"
  const isDegraded = status === "connected" && streamHealth !== "healthy"
  const isReconnecting = status === "reconnecting"
  const isDisconnected = status === "disconnected"

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

  return (
    <Popover>
      <PopoverTrigger asChild onMouseEnter={handleMouseEnter}>
        {/* Wrap children so we get onMouseEnter on the trigger */}
        <span className="contents">{children}</span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 p-3 bg-card text-card-foreground"
        onMouseEnter={handleMouseEnter}
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

        {/* ── Peers ── */}
        {peers.length > 0 && (
          <>
            <Separator className="my-2" />
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Team Members ({peers.length})
            </p>
            <div className="space-y-0.5">
              {peers.map((peer) => (
                <PeerRow key={peer.nodeId} peer={peer} />
              ))}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
