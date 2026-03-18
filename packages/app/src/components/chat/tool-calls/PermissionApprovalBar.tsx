import { useState } from "react";
import { CornerDownLeft, FolderOpen } from "lucide-react";
import { ToolCall, useSessionStore } from "@/stores/session";

// Shared permission approval bar — renders inline at the bottom of any tool card.
// Reads permission state directly from toolCall.permission (not global store).
export function PermissionApprovalBar({ toolCall }: { toolCall: ToolCall }) {
  const replyPermission = useSessionStore((s) => s.replyPermission);
  const [submitting, setSubmitting] = useState(false);

  const perm = toolCall.permission;
  if (!perm) return null;

  const isPending = perm.decision === "pending" && toolCall.status === "calling";
  const isDenied = perm.decision === "denied";
  const isResolved = perm.decision !== "pending";

  if (!isPending && !isResolved) return null;

  const isExternal = perm.permission === "external_directory";
  const permMeta = perm.metadata as Record<string, string> | undefined;
  const externalPath = permMeta?.filepath || permMeta?.file || perm.patterns?.[0] || "";
  const label = (perm.patterns?.[0] || toolCall.name).split(" ")[0];

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
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/20">
            <button
              onClick={() => handleReply("deny")}
              disabled={submitting}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              Deny
            </button>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => handleReply("always")}
                disabled={submitting}
                className="text-xs bg-muted hover:bg-muted/80 text-muted-foreground px-2.5 py-1 rounded transition-colors disabled:opacity-50"
              >
                Always allow &apos;{label}&apos;
              </button>
              <button
                onClick={() => handleReply("allow")}
                disabled={submitting}
                className="text-xs bg-primary hover:bg-primary/90 text-primary-foreground px-2.5 py-1 rounded font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                Allow
                <CornerDownLeft size={12} />
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
