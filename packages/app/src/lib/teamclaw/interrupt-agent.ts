import { getBackend } from "@/lib/backend";
import { discardPendingStreamReply } from "@/lib/live-agent-stream";
import { mqttPublish } from "@/lib/mqtt-bridge";
import { resolvePermissionCommandTarget } from "@/lib/runtime-state-resolve";
import { sessionFlowError, sessionFlowLog } from "@/lib/session-flow-log";
import { logStreamToolDiag } from "@/lib/stream-tool-diag";
import { createRuntimeCommandSender } from "@/lib/teamclaw/runtime-command";
import { runtimeCommand } from "@/lib/teamclaw-rpc";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { isStreamInterruptible, useV2StreamingStore } from "@/stores/v2-streaming-store";

function isAgentActorType(actorType: string | null | undefined): boolean {
  const t = (actorType ?? "").toLowerCase();
  return t === "agent" || t === "ai" || t === "assistant";
}

function cleanupLocalAgentStream(sessionId: string, agentActorId: string): void {
  discardPendingStreamReply(sessionId, agentActorId);
  logStreamToolDiag("interrupt.cleanup", { sessionId, agentActorId });
  useV2StreamingStore.getState().finishSessionActor(sessionId, agentActorId, {
    reason: "interrupt",
  });
}

export function listActiveAgentActorIdsForSession(sessionId: string): string[] {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) return [];
  const seen = new Set<string>();
  const actorIds: string[] = [];
  for (const entry of Object.values(useV2StreamingStore.getState().byKey)) {
    if (entry.sessionId !== trimmedSessionId || !isStreamInterruptible(entry)) continue;
    if (seen.has(entry.actorId)) continue;
    seen.add(entry.actorId);
    actorIds.push(entry.actorId);
  }
  return actorIds;
}

export async function interruptAgentActor(args: {
  sessionId: string;
  agentActorId: string;
}): Promise<void> {
  const sessionId = args.sessionId.trim();
  const agentActorId = args.agentActorId.trim();
  if (!sessionId || !agentActorId) {
    throw new Error("Session id and agent actor id are required");
  }

  const teamId = useCurrentTeamStore.getState().team?.id?.trim();
  if (!teamId) throw new Error("No active team");

  const senderActorId = useCurrentTeamStore.getState().currentMember?.id?.trim() ?? "";

  // Show stopping UI immediately — session-scoped resolve may take a Cloud API
  // round trip before cancel is published.
  useV2StreamingStore.getState().markInterruptedFlushPending(sessionId, agentActorId);

  // Interrupt targeting is deliberately session-scoped only. A single local
  // agent can run a distinct runtime per session, so we must resolve the
  // runtime that belongs to THIS session before cancelling — never a "latest
  // live retain for the agent" guess, which can cancel another session's turn.
  let agentParticipantIds: string[] = [agentActorId];
  try {
    const participants = await getBackend().sessionMembers.listParticipants(sessionId);
    agentParticipantIds = participants
      .filter((p) => isAgentActorType(p.actor_type))
      .map((p) => p.id)
      .filter(Boolean);
    if (!agentParticipantIds.includes(agentActorId)) {
      agentParticipantIds.push(agentActorId);
    }
  } catch (error) {
    console.warn("[interrupt-agent] participant lookup failed", error);
  }

  let sessionRuntimeRows: Array<{ agent_id: string | null; runtime_id: string | null }> = [];
  try {
    sessionRuntimeRows = await getBackend().runtime.listRuntimeTargetsForSession(
      sessionId,
      agentParticipantIds,
    );
  } catch (error) {
    console.warn("[interrupt-agent] runtime target lookup failed", error);
  }

  const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId;
  const target = resolvePermissionCommandTarget({
    agentActorId,
    sessionRuntimeRows,
    byRuntimeId,
  });

  if (!target) {
    useV2StreamingStore.getState().clearInterruptedFlushPending(sessionId, agentActorId);
    cleanupLocalAgentStream(sessionId, agentActorId);
    throw new Error("Could not resolve agent runtime for interrupt");
  }

  sessionFlowLog("interrupt.begin", {
    sessionId,
    agentActorId,
    targetActorId: target.actorId,
    runtimeId: target.runtimeId,
    sessionRuntimeId:
      sessionRuntimeRows.find((row) => row.agent_id?.trim() === agentActorId)?.runtime_id ??
      null,
  });

  const peerId = `teamclaw-desktop-${(senderActorId || "anon").slice(0, 8)}`;
  const sender = createRuntimeCommandSender({
    mqtt: { publish: mqttPublish },
    // Session-addressed dispatch with a delivery receipt; falls back to the
    // per-spawn topic when no session id reaches here.
    rpc: ({ targetActorId, sessionId: sid, envelope }) =>
      runtimeCommand({ targetActorId, sessionId: sid, envelope }),
    teamId,
    peerId,
    senderActorId,
  });

  try {
    await sender.sendCancel({
      targetActorId: target.actorId,
      runtimeId: target.runtimeId,
      sessionId,
    });
  } catch (error) {
    useV2StreamingStore.getState().clearInterruptedFlushPending(sessionId, agentActorId);
    cleanupLocalAgentStream(sessionId, agentActorId);
    sessionFlowError("interrupt.failed", error, {
      sessionId,
      agentActorId,
      runtimeId: target.runtimeId,
    });
    throw error;
  }

  // Wait for daemon Active→Idle + message.created; App.tsx finalizes the
  // partial turn via flushPendingStreamReply on statusChange.
  // interruptedFlushPending was marked at the start of this function.

  sessionFlowLog("interrupt.ok", {
    sessionId,
    agentActorId,
    runtimeId: target.runtimeId,
  });
}

export async function interruptAllActiveAgents(sessionId: string): Promise<void> {
  const actorIds = listActiveAgentActorIdsForSession(sessionId);
  if (actorIds.length === 0) return;
  await Promise.allSettled(
    actorIds.map((agentActorId) => interruptAgentActor({ sessionId, agentActorId })),
  );
}
