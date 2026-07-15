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

export type EmptyThreadStarter = {
  id: string
  labelKey: string
  labelDefault: string
  messageKey: string
  messageDefault: string
  labelParams?: Record<string, string>
  messageParams?: Record<string, string>
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

export function buildEmptyThreadStarters(
  participants: EmptyThreadParticipant[],
): EmptyThreadStarter[] {
  const agents = participants.filter((p) => p.isAgent && !p.isSelf)
  const members = participants.filter((p) => !p.isAgent && !p.isSelf)

  if (agents.length === 1 && participants.length <= 2) {
    return [
      {
        id: 'workspace-changes',
        labelKey: 'chat.sessionEmptyThread.starters.workspaceChanges.label',
        labelDefault: 'Review workspace changes',
        messageKey: 'chat.sessionEmptyThread.starters.workspaceChanges.message',
        messageDefault: 'What uncommitted changes are in the current workspace?',
      },
      {
        id: 'project-structure',
        labelKey: 'chat.sessionEmptyThread.starters.projectStructure.label',
        labelDefault: 'Summarize project structure',
        messageKey: 'chat.sessionEmptyThread.starters.projectStructure.message',
        messageDefault: 'Summarize this repo in a few sentences.',
      },
    ]
  }

  const starters: EmptyThreadStarter[] = []

  for (const agent of agents.slice(0, 2)) {
    starters.push({
      id: `agent-summary-${agent.actorId}`,
      labelKey: 'chat.sessionEmptyThread.starters.askAgentSummary.label',
      labelDefault: '@{{name}} Summarize status',
      messageKey: 'chat.sessionEmptyThread.starters.askAgentSummary.message',
      messageDefault: '@{{name}} Summarize the current project status in a few sentences.',
      labelParams: { name: agent.displayName },
      messageParams: { name: agent.displayName },
    })
  }

  if (members[0]) {
    starters.push({
      id: `member-opinion-${members[0].actorId}`,
      labelKey: 'chat.sessionEmptyThread.starters.askMember.label',
      labelDefault: '@{{name}} Your thoughts?',
      messageKey: 'chat.sessionEmptyThread.starters.askMember.message',
      messageDefault: '@{{name}} What do you think about this direction?',
      labelParams: { name: members[0].displayName },
      messageParams: { name: members[0].displayName },
    })
  }

  starters.push({
    id: 'broadcast',
    labelKey: 'chat.sessionEmptyThread.starters.broadcast.label',
    labelDefault: 'Sync with everyone',
    messageKey: 'chat.sessionEmptyThread.starters.broadcast.message',
    messageDefault: 'Everyone — let\'s align on today\'s goals:',
  })

  return starters.slice(0, 4)
}
