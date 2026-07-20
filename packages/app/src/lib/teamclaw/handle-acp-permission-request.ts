import { shouldAutoAllowSessionPermissions } from "@/lib/session-permission-mode";
import { replyAcpPermission } from "@/lib/teamclaw/reply-acp-permission";
import { wasPermissionRecentlyResolved } from "@/lib/teamclaw/handle-session-event-permission-resolved";
import type { StreamingPermissionRequest } from "@/stores/v2-streaming-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { useCurrentTeamStore } from "@/stores/current-team";

const inFlightRequestIds = new Set<string>();

function requesterActorIdFromRequest(request: StreamingPermissionRequest): string {
  return (
    request.requesterActorId?.trim() ||
    request.params?.requester_actor_id?.trim() ||
    ""
  );
}

/** Interactive / auto-allow allowed when legacy (empty) or current member is requester. */
export function canCurrentMemberActOnPermission(
  request: StreamingPermissionRequest,
  currentMemberId?: string | null,
): boolean {
  const requester = requesterActorIdFromRequest(request);
  if (!requester) return true; // legacy daemon
  const me = (currentMemberId ?? useCurrentTeamStore.getState().currentMember?.id ?? "").trim();
  return Boolean(me) && me === requester;
}

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

  if (wasPermissionRecentlyResolved(requestId)) {
    return;
  }

  if (inFlightRequestIds.has(requestId)) {
    return;
  }

  const store = useV2StreamingStore.getState();
  const normalized: StreamingPermissionRequest = {
    ...args.request,
    requestId,
    requesterActorId:
      args.request.requesterActorId?.trim() ||
      args.request.params?.requester_actor_id?.trim() ||
      undefined,
  };

  const writePending = () => {
    store.setPermissionRequest(args.sessionId, args.agentActorId, normalized);
  };

  const canAct = canCurrentMemberActOnPermission(normalized);

  // Bystander with stamped requester: still store pending for waiting banner,
  // but never auto-allow or show interactive controls (UI filters separately).
  if (!canAct) {
    writePending();
    return;
  }

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
