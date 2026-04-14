import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { ToolCall, useSessionStore } from "@/stores/session";
import { truncatePermissionSnippet } from "@/lib/utils";

// Shared permission approval bar — renders inline at the bottom of any tool card.
// Reads permission state directly from toolCall.permission (not global store).
export function PermissionApprovalBar({ toolCall }: { toolCall: ToolCall }) {
  const replyPermission = useSessionStore((s) => s.replyPermission);
  const [submitting, setSubmitting] = useState(false);

  const perm = toolCall.permission;
  if (!perm) return null;

  const isPending =
    perm.decision === "pending" &&
    (toolCall.status === "calling" || toolCall.status === "waiting");
  const isDenied = perm.decision === "denied";
  const isResolved = perm.decision !== "pending";

  if (!isPending && !isResolved) return null;

  const isExternal = perm.permission === "external_directory";
  const permMeta = perm.metadata as Record<string, string> | undefined;
  const externalPath = permMeta?.filepath || permMeta?.file || perm.patterns?.[0] || "";
  const label = (perm.patterns?.[0] || toolCall.name).split(" ")[0];
  const allowListLabel = truncatePermissionSnippet(label, 42);

  const handleReply = async (d: "allow" | "deny" | "always") => {
    setSubmitting(true);
    try {
      await replyPermission(perm.id, d);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {isPending && (
        <div className="border-t border-border/50">
          {isExternal && externalPath && (
            <div className="flex items-start gap-2 px-3 py-2 bg-muted/50">
              <FolderOpen size={13} className="text-muted-foreground shrink-0 mt-0.5" />
              <div className="min-w-0">
                <span className="text-[11px] font-medium text-foreground">
                  External path — outside workspace
                </span>
                <code className="block text-[11px] font-mono text-muted-foreground mt-0.5 break-all">
                  {externalPath}
                </code>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/20 min-w-0">
            <button
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
                className="shrink-0 text-xs bg-primary hover:bg-primary/90 text-primary-foreground px-2.5 py-1 rounded font-medium transition-colors disabled:opacity-50"
              >
                Allow
              </button>
            </div>
          </div>
        </div>
      )}
      {isDenied && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border/50 bg-muted/10">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">
            Denied by user
          </span>
        </div>
      )}
    </>
  );
}
