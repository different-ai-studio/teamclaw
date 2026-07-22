import { isAgentActorType } from '@/lib/actor-type'

export type EmptyThreadParticipant = {
  actorId: string
  displayName: string
  isAgent: boolean
  isSelf: boolean
}

export type EmptyThreadRoutingKind = 'soloAgent' | 'singleAgent' | 'multiAgent'

export type SoloSessionParticipant =
  | { actor_type?: string | null }
  | Pick<EmptyThreadParticipant, 'isAgent'>

function isAgentParticipant(p: SoloSessionParticipant): boolean {
  if ('isAgent' in p && typeof p.isAgent === 'boolean') return p.isAgent
  if ('actor_type' in p) return isAgentActorType(p.actor_type)
  return false
}

/** Exactly one agent and one other participant (solo human + agent pair). */
export function isSoloAgentSession(participants: SoloSessionParticipant[]): boolean {
  const agents = participants.filter(isAgentParticipant)
  return agents.length === 1 && participants.length === 2
}

export function resolveEmptyThreadRoutingKind(
  participants: EmptyThreadParticipant[],
): EmptyThreadRoutingKind {
  if (isSoloAgentSession(participants)) {
    return 'soloAgent'
  }
  const agents = participants.filter((p) => p.isAgent)
  if (agents.length === 1) {
    return 'singleAgent'
  }
  return 'multiAgent'
}

export function formatEmptyThreadRosterNames(
  participants: EmptyThreadParticipant[],
  selfLabel: string,
  nameSeparator: string,
): string {
  return participants
    .map((p) => (p.isSelf ? selfLabel : p.displayName))
    .join(nameSeparator)
}
