import * as React from "react"
import { Shield, Terminal, FileText, FolderOpen, CornerDownLeft } from "lucide-react"
import { cn, truncatePermissionSnippet } from "@/lib/utils"
import { useSessionStore } from "@/stores/session"
import { useStreamingStore } from "@/stores/streaming"

const permissionMeta: Record<string, { icon: React.ComponentType<{ className?: string }>; title: string }> = {
  bash: { icon: Terminal, title: "Run command" },
  execute: { icon: Terminal, title: "Run command" },
  write: { icon: FileText, title: "Write file" },
  edit: { icon: FileText, title: "Edit file" },
  read: { icon: FileText, title: "Read file" },
  external_directory: { icon: FolderOpen, title: "Access external path" },
  skill: { icon: Terminal, title: "Run skill" },
}

/**
 * Fallback inline permission card for the rare case where a permission
 * has no tool.callID (floating permission). Tool-call-based permissions
 * are handled by PermissionApprovalBar inside each ToolCallCard.
 */
export function PendingPermissionInline() {
  const pendingPermission = useSessionStore(s => s.pendingPermission)
  const pendingPermissionChildSessionId = useSessionStore(s => s.pendingPermissionChildSessionId)
  const childSessionStreaming = useStreamingStore(s => s.childSessionStreaming)
  const replyPermission = useSessionStore(s => s.replyPermission)
  const [submitting, setSubmitting] = React.useState(false)
  const [decided, setDecided] = React.useState<string | null>(null)

  const prevPermIdRef = React.useRef<string | null>(null)
  if (pendingPermission?.id !== prevPermIdRef.current) {
    prevPermIdRef.current = pendingPermission?.id ?? null
    if (decided !== null) setDecided(null)
  }

  // Lifecycle binding: only render if this is a CHILD session permission and the child session is still active
  // Main session permissions should be rendered via PermissionApprovalBar in tool call cards, not here
  const isChildSessionPermission = !!pendingPermissionChildSessionId;
  const isChildSessionAlive = isChildSessionPermission 
    ? !!childSessionStreaming[pendingPermissionChildSessionId]
    : false; // Not a child session permission, don't render
  
  if (!pendingPermission || !isChildSessionPermission || !isChildSessionAlive) return null

  const permType = pendingPermission.permission || "write"
  const isExternal = permType === "external_directory"
  const meta = permissionMeta[permType] || { icon: Shield, title: "Permission required" }
  const Icon = meta.icon
  const isBash = permType === "bash" || permType === "execute"

  const commandText = pendingPermission.patterns?.join(" ") || ""
  const metadata = pendingPermission.metadata as Record<string, string> | undefined
  const filePath = metadata?.file || metadata?.filepath || ""
  const label = commandText.split(" ")[0] || permType
  const allowListLabel = truncatePermissionSnippet(label, 42)

  const handleReply = async (d: "allow" | "deny" | "always") => {
    setSubmitting(true)
    setDecided(d)
    try {
      await replyPermission(pendingPermission.id, d)
    } finally {
      setSubmitting(false)
    }
  }

  const isPending = decided === null

  return (
    <div className="pl-1 mt-1 mb-1.5 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="rounded-lg border border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 max-w-md overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2">
          <div className="p-1 rounded bg-amber-100 dark:bg-amber-900/40">
            <Icon className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-medium text-foreground">{meta.title}</span>
            {isExternal && (
              <span className="text-[10px] text-amber-600 dark:text-amber-400">
                Outside workspace — requires approval
              </span>
            )}
          </div>
          {!isPending && (
            <span className={cn(
              "ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0",
              decided === "deny"
                ? "bg-red-500/10 text-red-600 dark:text-red-400"
                : "bg-green-500/10 text-green-600 dark:text-green-400",
            )}>
              {decided === "deny" ? "Denied" : decided === "always" ? "Allowlisted" : "Allowed"}
            </span>
          )}
        </div>

        {isBash && commandText ? (
          <div className="px-3 pb-2">
            <div className="flex items-start gap-2 rounded bg-muted/60 px-2 py-1.5">
              <span className="text-muted-foreground select-none shrink-0 text-xs">$</span>
              <code className="text-xs font-mono text-foreground break-all">{commandText}</code>
            </div>
          </div>
        ) : filePath ? (
          <div className="px-3 pb-2">
            <code className="text-xs font-mono text-muted-foreground break-all">{filePath}</code>
          </div>
        ) : null}

        {isPending && (
          <div className="flex min-w-0 items-center gap-2 px-3 py-2 border-t border-amber-500/20">
            <button
              type="button"
              onClick={() => handleReply("deny")}
              disabled={submitting}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 shrink-0"
            >
              Deny
            </button>
            <div className="ml-auto flex min-w-0 shrink items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => handleReply("always")}
                disabled={submitting}
                title={label}
                className="min-w-0 max-w-[min(100%,14rem)] shrink truncate text-left text-xs bg-muted hover:bg-muted/80 text-muted-foreground px-2.5 py-1 rounded transition-colors disabled:opacity-50"
              >
                Always allow &apos;{allowListLabel}&apos;
              </button>
              <button
                type="button"
                onClick={() => handleReply("allow")}
                disabled={submitting}
                className="shrink-0 text-xs bg-primary hover:bg-primary/90 text-primary-foreground px-2.5 py-1 rounded font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                Allow
                <CornerDownLeft size={12} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
