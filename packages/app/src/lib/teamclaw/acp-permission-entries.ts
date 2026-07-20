import type { PendingPermissionEntry } from "@/stores/session-types";
import type { StreamingPermissionRequest } from "@/stores/v2-streaming-store";
import { shouldAutoAllowSessionPermissions } from "@/lib/session-permission-mode";
import { canCurrentMemberActOnPermission } from "@/lib/teamclaw/handle-acp-permission-request";
import { useCurrentTeamStore } from "@/stores/current-team";

function inferPermissionType(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.includes("bash") || n.includes("shell") || n.includes("terminal") || n === "execute") {
    return "bash";
  }
  if (n.includes("write")) return "write";
  if (n.includes("edit")) return "edit";
  if (n.includes("read")) return "read";
  if (n.includes("skill")) return "skill";
  return n || "execute";
}

export function buildPendingEntryFromAcpPermission(
  sessionId: string,
  agentActorId: string,
  req: StreamingPermissionRequest,
): PendingPermissionEntry {
  const permType = inferPermissionType(req.toolName);
  const command =
    req.params.command ??
    req.params.cmd ??
    req.description ??
    req.toolName;
  const requesterActorId =
    req.requesterActorId?.trim() || req.params.requester_actor_id?.trim() || "";

  return {
    permission: {
      id: req.requestId,
      sessionID: sessionId,
      permission: permType,
      patterns: command ? [command] : [],
      metadata: {
        ...req.params,
        _acp_agent_actor_id: agentActorId,
        ...(requesterActorId ? { requester_actor_id: requesterActorId } : {}),
      },
      always: [],
    },
    childSessionId:
      (req.params.childSessionId as string | undefined)?.trim() || null,
    sourceToolName: req.toolName || null,
    sourceToolCallId:
      (req.params.toolCallId as string | undefined)?.trim() || null,
  };
}

type StreamKeyEntry = {
  sessionId: string;
  actorId: string;
  pendingPermissionsByRequestId: Record<string, StreamingPermissionRequest>;
};

function forEachPendingInSession(
  activeSessionId: string,
  byKey: Record<string, StreamKeyEntry>,
  visit: (entry: StreamKeyEntry, pending: StreamingPermissionRequest) => void,
): void {
  for (const entry of Object.values(byKey)) {
    if (entry.sessionId !== activeSessionId) continue;
    for (const pending of Object.values(entry.pendingPermissionsByRequestId)) {
      if (!pending.requestId?.trim()) continue;
      visit(entry, pending);
    }
  }
}

/** Interactive Allow/Deny queue — excludes bystander-stamped requests. */
export function collectAcpStreamingPermissions(
  activeSessionId: string | null,
  byKey: Record<string, StreamKeyEntry>,
): PendingPermissionEntry[] {
  if (!activeSessionId) return [];
  if (shouldAutoAllowSessionPermissions(activeSessionId)) return [];
  const me = useCurrentTeamStore.getState().currentMember?.id ?? null;
  const out: PendingPermissionEntry[] = [];
  forEachPendingInSession(activeSessionId, byKey, (entry, pending) => {
    if (!canCurrentMemberActOnPermission(pending, me)) return;
    out.push(buildPendingEntryFromAcpPermission(entry.sessionId, entry.actorId, pending));
  });
  return out;
}

/**
 * Pending permissions stamped for another member — used for the read-only
 * “等待 XXX 批准” banner (Phase 2.5). Legacy empty requester is excluded.
 */
export function collectAcpBystanderWaitingPermissions(
  activeSessionId: string | null,
  byKey: Record<string, StreamKeyEntry>,
): PendingPermissionEntry[] {
  if (!activeSessionId) return [];
  const me = useCurrentTeamStore.getState().currentMember?.id ?? null;
  const out: PendingPermissionEntry[] = [];
  forEachPendingInSession(activeSessionId, byKey, (entry, pending) => {
    const requester =
      pending.requesterActorId?.trim() || pending.params?.requester_actor_id?.trim() || "";
    if (!requester) return;
    if (canCurrentMemberActOnPermission(pending, me)) return;
    out.push(buildPendingEntryFromAcpPermission(entry.sessionId, entry.actorId, pending));
  });
  return out;
}
