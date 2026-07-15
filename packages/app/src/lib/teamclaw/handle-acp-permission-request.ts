import { shouldAutoAllowSessionPermissions } from "@/lib/session-permission-mode";
import { replyAcpPermission } from "@/lib/teamclaw/reply-acp-permission";
import type { StreamingPermissionRequest } from "@/stores/v2-streaming-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

const inFlightRequestIds = new Set<string>();

export async function handleAcpPermissionRequest(args: {
  sessionId: string;
  agentActorId: string;
  request: StreamingPermissionRequest;
}): Promise<void> {
  const requestId = args.request.requestId?.trim() ?? "";
  if (!requestId) {
    console.warn("[permission] empty requestId, ignoring permissionRequest");
    return;
  }

  if (inFlightRequestIds.has(requestId)) {
    return;
  }

  const store = useV2StreamingStore.getState();
  const writePending = () => {
    store.setPermissionRequest(args.sessionId, args.agentActorId, args.request);
  };

  if (!shouldAutoAllowSessionPermissions(args.sessionId)) {
    writePending();
    return;
  }

  inFlightRequestIds.add(requestId);
  try {
    await replyAcpPermission({
      sessionId: args.sessionId,
      agentActorId: args.agentActorId,
      requestId,
      decision: "allow",
    });
  } catch (err) {
    console.error("[permission] session auto-allow failed", err);
    writePending();
  } finally {
    inFlightRequestIds.delete(requestId);
  }
}

/** Test helper */
export function resetAcpPermissionInFlightForTests(): void {
  inFlightRequestIds.clear();
}
