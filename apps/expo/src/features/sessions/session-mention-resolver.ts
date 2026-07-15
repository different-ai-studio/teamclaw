import type { Actor } from "../actors/actor-types";
import type { SessionSummary } from "./session-types";

type ResolveMentionActorIdsInput = {
  content: string;
  session: SessionSummary;
  teamActors: ReadonlyArray<Actor>;
};

type ResolveInitialMessageMentionActorIdsInput = {
  collaboratorActorIds: ReadonlyArray<string>;
  teamActors: ReadonlyArray<Actor>;
};

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contentMentionsDisplayName(content: string, displayName: string): boolean {
  const name = displayName.trim();
  if (!name) return false;
  return new RegExp(`(^|\\s)@${escapedRegExp(name)}(?=$|\\s|[.,!?;:()[\\]{}<>　。，！？])`).test(content);
}

export function resolveMentionActorIdsForComposer({
  content,
  session,
  teamActors,
}: ResolveMentionActorIdsInput): string[] {
  const participantIds = new Set(session.participantActorIds);
  const agentParticipants = teamActors.filter(
    (actor) => actor.actorType === "agent" && participantIds.has(actor.actorId),
  );
  const explicitMentions = agentParticipants
    .filter((actor) => contentMentionsDisplayName(content, actor.displayName))
    .map((actor) => actor.actorId);

  if (explicitMentions.length > 0) {
    return [...new Set(explicitMentions)];
  }

  return agentParticipants.length === 1 ? [agentParticipants[0]!.actorId] : [];
}

export function resolveInitialMessageMentionActorIds({
  collaboratorActorIds,
  teamActors,
}: ResolveInitialMessageMentionActorIdsInput): string[] {
  const actorById = new Map(teamActors.map((actor) => [actor.actorId, actor]));
  const mentionIds: string[] = [];

  for (const actorId of collaboratorActorIds) {
    const actor = actorById.get(actorId);
    if (!actor || actor.actorType !== "agent") continue;
    if (!mentionIds.includes(actor.actorId)) {
      mentionIds.push(actor.actorId);
    }
  }

  return mentionIds;
}
