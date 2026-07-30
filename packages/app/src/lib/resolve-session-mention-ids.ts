import { getBackend } from "@/lib/backend";
import { resolveActorIdsFromAtText } from "@/lib/resolve-text-mentions";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";

/**
 * Resolve `mention_actor_ids` for an outgoing message — WYSIWYG only.
 *
 * Agent routing follows what the user explicitly chose:
 * - engaged-agent pill in the composer footer
 * - `@displayName` typed in the message body
 * - human member @ tokens / picker mentions (memberIds)
 *
 * There is no send-time fallback that silently @-mentions a session agent.
 */
export async function resolveSessionMentionActorIds(
  sessionId: string,
  memberIds: string[],
  agentIds: string[],
  messageText = "",
): Promise<string[]> {
  const fromText = await resolveActorIdsFromAtText(sessionId, messageText);

  // Keep the pill in sync when the user typed `@AgentName` inline.
  if (fromText.agentIds.length > 0) {
    const engaged = useEngagedAgentStore.getState();
    let participants: Array<{ id: string; display_name?: string | null }>;
    try {
      participants = await getBackend().sessionMembers.listParticipants(sessionId);
    } catch {
      participants = [];
    }
    for (const agentId of fromText.agentIds) {
      const row = participants.find((p) => p.id === agentId);
      engaged.addAgent(sessionId, {
        id: agentId,
        displayName: row?.display_name || "AI",
      });
      break;
    }
  }

  return Array.from(
    new Set([
      ...memberIds,
      ...agentIds.slice(0, 1),
      ...fromText.memberIds,
      ...(fromText.agentIds[0] ? [fromText.agentIds[0]] : []),
    ]),
  );
}
