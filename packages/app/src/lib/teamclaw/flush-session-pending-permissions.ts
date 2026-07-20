import { canCurrentMemberActOnPermission } from "@/lib/teamclaw/handle-acp-permission-request";
import { replyAcpPermission } from "@/lib/teamclaw/reply-acp-permission";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

export async function flushSessionPendingPermissions(sessionId: string): Promise<void> {
  const trimmed = sessionId.trim();
  if (!trimmed) return;

  const byKey = useV2StreamingStore.getState().byKey;
  const pending: Array<{
    sessionId: string;
    actorId: string;
    requestId: string;
  }> = [];

  for (const entry of Object.values(byKey)) {
    if (entry.sessionId !== trimmed) continue;
    for (const req of Object.values(entry.pendingPermissionsByRequestId)) {
      const requestId = req.requestId?.trim() ?? "";
      if (!requestId) continue;
      // Bystander-stamped requests must not be auto-granted via fullAccess flush.
      if (!canCurrentMemberActOnPermission(req)) continue;
      pending.push({
        sessionId: entry.sessionId,
        actorId: entry.actorId,
        requestId,
      });
    }
  }

  for (const item of pending) {
    try {
      await replyAcpPermission({
        sessionId: item.sessionId,
        agentActorId: item.actorId,
        requestId: item.requestId,
        decision: "allow",
      });
    } catch (err) {
      console.error("[permission] flush auto-allow failed", err);
    }
  }
}
