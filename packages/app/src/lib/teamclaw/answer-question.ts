import { getBackend } from "@/lib/backend";
import { mqttPublish } from "@/lib/mqtt-bridge";
import { resolvePermissionCommandTarget } from "@/lib/runtime-state-resolve";
import { sessionFlowError, sessionFlowLog } from "@/lib/session-flow-log";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { createRuntimeCommandSender } from "@/lib/teamclaw/runtime-command";

function isAgentActorType(actorType: string | null | undefined): boolean {
  const t = (actorType ?? "").toLowerCase();
  return t === "agent" || t === "ai" || t === "assistant";
}

/**
 * Send the user's answers (or a rejection) for an opencode `question` tool
 * request. Target resolution mirrors permission replies: session participants
 * → runtime rows → live MQTT retains.
 */
export async function answerAcpQuestion(args: {
  sessionId: string;
  agentActorId: string;
  requestId: string;
  /** `[[selected labels], ...]` — one array per question, in order. */
  answers: string[][];
  reject?: boolean;
}): Promise<void> {
  const teamId = useCurrentTeamStore.getState().team?.id?.trim();
  if (!teamId) throw new Error("No active team");
  const senderActorId = useCurrentTeamStore.getState().currentMember?.id?.trim() ?? "";

  let agentParticipantIds: string[] = [args.agentActorId];
  try {
    const participants = await getBackend().sessionMembers.listParticipants(args.sessionId);
    agentParticipantIds = participants
      .filter((p) => isAgentActorType(p.actor_type))
      .map((p) => p.id)
      .filter(Boolean);
    if (!agentParticipantIds.includes(args.agentActorId)) {
      agentParticipantIds.push(args.agentActorId);
    }
  } catch (error) {
    console.warn("[answer-question] participant lookup failed", error);
  }

  let sessionRuntimeRows: Array<{ agent_id: string | null; runtime_id: string | null }> = [];
  try {
    sessionRuntimeRows = await getBackend().runtime.listRuntimeTargetsForSession(
      args.sessionId,
      agentParticipantIds,
    );
  } catch (error) {
    console.warn("[answer-question] runtime target lookup failed", error);
  }

  const target = resolvePermissionCommandTarget({
    agentActorId: args.agentActorId,
    sessionRuntimeRows,
    byRuntimeId: useRuntimeStateStore.getState().byRuntimeId,
  });
  if (!target) {
    throw new Error("Could not resolve agent runtime for question answer");
  }

  const peerId = `teamclaw-desktop-${(senderActorId || "anon").slice(0, 8)}`;
  const sender = createRuntimeCommandSender({
    mqtt: { publish: mqttPublish },
    teamId,
    peerId,
    senderActorId,
  });

  try {
    await sender.sendAnswerQuestion({
      targetActorId: target.actorId,
      runtimeId: target.runtimeId,
      requestId: args.requestId,
      answers: args.answers,
      reject: args.reject,
    });
  } catch (error) {
    sessionFlowError("question.answer.failed", error, {
      sessionId: args.sessionId,
      requestId: args.requestId,
      runtimeId: target.runtimeId,
    });
    throw error;
  }
  sessionFlowLog("question.answer.ok", {
    sessionId: args.sessionId,
    requestId: args.requestId,
    reject: !!args.reject,
    runtimeId: target.runtimeId,
  });
}
