import { parseAtMentionNames } from "@/lib/resolve-text-mentions";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";

/**
 * When the composer already has an engaged/preselected agent and the body has
 * no free-form `@Name` tokens, mention_actor_ids need no network round-trip.
 * Returns null when async resolution is still required (solo fallback, @text).
 */
export function trySyncMentionActorIds(
  memberIds: string[],
  agentIds: string[],
  messageText: string,
): string[] | null {
  if (parseAtMentionNames(messageText).length > 0) return null;
  if (agentIds.length === 0) return null;
  return Array.from(new Set([...memberIds, agentIds[0]!]));
}

/**
 * Team id for an outgoing message, in strict priority order:
 * session-list row → the session's own team from the backend → selected team.
 *
 * The backend lookup must outrank the selected team: a session missing from the
 * (capped, lazily-loaded) list would otherwise be sent under the wrong team and
 * the Cloud insert would fail.
 */
export async function resolveSendTeamId(args: {
  sessionId: string;
  teamIdFromSessionList: string | null;
  fetchSessionTeamId: (sessionId: string) => Promise<string | null>;
  currentTeamId: () => string | null;
}): Promise<string | null> {
  if (args.teamIdFromSessionList) return args.teamIdFromSessionList;
  if (args.sessionId) {
    const fromBackend = await args.fetchSessionTeamId(args.sessionId);
    if (fromBackend) return fromBackend;
  }
  return args.currentTeamId();
}

/**
 * Pick agent ids for model selection / pending-reply marking without a fresh
 * listParticipants call when the pill or roster cache already knows the agent.
 */
export function resolveAgentRuntimeIdsForSend(
  sessionId: string,
  agentForSendId: string | null | undefined,
  mentionActorIds: string[],
): string[] {
  if (agentForSendId) return [agentForSendId];

  const cached =
    useSessionParticipantStore.getState().participantsBySession[sessionId];
  if (cached && cached.length > 0) {
    const agents = new Set(
      cached.filter((participant) => participant.isAgent).map((p) => p.actorId),
    );
    return mentionActorIds.filter((id) => agents.has(id));
  }

  const engaged = useEngagedAgentStore.getState().get(sessionId);
  if (engaged?.id && mentionActorIds.includes(engaged.id)) {
    return [engaged.id];
  }

  return [];
}
