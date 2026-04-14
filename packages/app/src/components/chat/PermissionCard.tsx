import * as React from "react"
import { Shield, Terminal, FileText, FolderOpen } from "lucide-react"
import { cn } from "@/lib/utils"
import { useSessionStore } from "@/stores/session"
import type { PendingPermissionEntry } from "@/stores/session-types"

const permissionMeta: Record<string, { icon: React.ComponentType<{ className?: string }>; title: string }> = {
  bash: { icon: Terminal, title: "Run command" },
  execute: { icon: Terminal, title: "Run command" },
  write: { icon: FileText, title: "Write file" },
  edit: { icon: FileText, title: "Edit file" },
  read: { icon: FileText, title: "Read file" },
  external_directory: { icon: FolderOpen, title: "Access external path" },
  skill: { icon: Terminal, title: "Run skill" },
}

function PermissionEntryCard({ entry, pendingCount }: { entry: PendingPermissionEntry; pendingCount: number }) {
  const replyPermission = useSessionStore((s) => s.replyPermission)
  const [submitting, setSubmitting] = React.useState(false)
  const [decided, setDecided] = React.useState<string | null>(null)

  const prevPermIdRef = React.useRef<string | null>(null)
  if (entry.permission.id !== prevPermIdRef.current) {
    prevPermIdRef.current = entry.permission.id
    if (decided !== null) setDecided(null)
  }

  const permType = entry.permission.permission || "write"
  const isExternal = permType === "external_directory"
  const meta = permissionMeta[permType] || { icon: Shield, title: "Permission required" }
  const Icon = meta.icon

  const metadata = entry.permission.metadata as Record<string, string> | undefined
  const commandText = entry.permission.patterns?.join(" ") || ""
  const filePath = metadata?.file || metadata?.filepath || ""
  const skillName = metadata?.skill || metadata?.name || ""
  const firstPattern = entry.permission.patterns?.[0] || ""

  const detail = (() => {
    if (permType === "bash" || permType === "execute") {
      return { label: "Command", value: commandText || firstPattern || permType, prefix: "$" }
    }
    if (filePath) {
      return { label: "Path", value: filePath }
    }
    if (permType === "skill") {
      return { label: "Skill", value: skillName || firstPattern || "Requested skill" }
    }
    if (firstPattern) {
      return { label: "Scope", value: firstPattern }
    }
    return { label: "Permission", value: permType }
  })()

  const handleReply = async (d: "allow" | "deny" | "always") => {
    setSubmitting(true)
    setDecided(d)
    try {
      await replyPermission(entry.permission.id, d)
    } finally {
      setSubmitting(false)
    }
  }

  const isPending = decided === null

  return (
    <div className="pointer-events-auto">
      <div
        data-testid="pending-permission-card"
        className="w-full overflow-hidden rounded-t-[18px] rounded-b-none bg-card animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-250 motion-reduce:animate-none"
      >
        <div className="px-3.5 py-2">
          <div className="flex items-start gap-3">
            <div className="flex h-8.5 w-8.5 items-center justify-center rounded-2xl bg-muted text-foreground">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-foreground">{meta.title}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {isExternal ? "Subagent requests access outside the workspace" : "Subagent is waiting for your approval"}
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {pendingCount} pending
            </span>
            {!isPending && (
              <span className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-medium shrink-0",
                decided === "deny"
                  ? "border-red-200 bg-red-50 text-red-600 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-300"
                  : "border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300",
              )}>
                {decided === "deny" ? "Denied" : decided === "always" ? "Allowlisted" : "Allowed"}
              </span>
            )}
          </div>
        </div>

        <div className="px-3.5 pt-0 pb-2.5">
          <div className="rounded-2xl bg-muted/50 px-3 py-1.5">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/80">
              {detail.label}
            </div>
            <div className="flex items-start gap-2">
              {detail.prefix ? (
                <span className="select-none text-[13px] text-primary shrink-0">{detail.prefix}</span>
              ) : null}
              <code className="text-[13px] font-mono text-foreground break-all">{detail.value}</code>
            </div>
          </div>
        </div>

        {isPending && (
          <div className="px-3.5 pt-0 pb-2.5">
            <div
              data-testid="pending-permission-actions"
              className="ml-auto flex w-fit items-center gap-1 rounded-xl bg-muted/40 p-0.5"
            >
              <button
                type="button"
                onClick={() => handleReply("deny")}
                disabled={submitting}
                className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:opacity-50"
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => handleReply("always")}
                disabled={submitting}
                className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:opacity-50"
              >
                Always allow
              </button>
              <button
                type="button"
                onClick={() => handleReply("allow")}
                disabled={submitting}
                className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                Allow
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Fallback inline permission card for the rare case where a permission
 * has no tool.callID (floating permission). Tool-call-based permissions
 * are handled by PermissionApprovalBar inside each ToolCallCard.
 */
export function PendingPermissionInline() {
  const pendingPermissions = useSessionStore(s => s.pendingPermissions)

  const visiblePermissions = pendingPermissions.filter((entry) => !!entry.childSessionId)

  if (visiblePermissions.length === 0) return null

  const currentEntry = visiblePermissions[0]
  const queuedCount = visiblePermissions.length
  const backplateCount = Math.min(Math.max(queuedCount - 1, 0), 2)

  return (
    <div
      data-testid="pending-permission-inline"
      className="relative z-0 mx-auto mb-[-65px] mt-3 flex w-[min(92vw,40rem)] justify-center"
    >
      <div className="w-full">
        <div className="relative">
          {Array.from({ length: backplateCount }).map((_, index) => (
            <div
              key={`backplate-${index}`}
              data-testid="pending-permission-backplate"
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-x-0 rounded-t-[18px] rounded-b-none bg-card/88",
                index === 0 && "top-3 h-[calc(100%-10px)] scale-[0.985]",
                index === 1 && "top-6 h-[calc(100%-20px)] scale-[0.97]",
              )}
            />
          ))}
          <div className="relative z-[1]">
            <PermissionEntryCard entry={currentEntry} pendingCount={queuedCount} />
            <div
              data-testid="pending-permission-tail"
              aria-hidden="true"
              className="pointer-events-none h-16 bg-card"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
