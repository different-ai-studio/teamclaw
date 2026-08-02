import { getLocalDaemonAgent } from '@/lib/daemon-agent-admin'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useUIStore } from '@/stores/ui'

export type QuickDaemonSessionResult = {
  agentDisplayName: string
}

/**
 * Open a draft chat with the local amuxd agent. Does NOT create a backend
 * session — that happens on the first outgoing message.
 * Returns null when team/agent prerequisites are missing.
 */
export async function createQuickDaemonSession(): Promise<QuickDaemonSessionResult | null> {
  const teamId = useCurrentTeamStore.getState().team?.id ?? null
  if (!teamId) return null

  const agent = await getLocalDaemonAgent(teamId)
  if (!agent?.id) return null

  const displayName = agent.displayName || agent.id
  useUIStore.getState().enterActorDraft({
    id: agent.id,
    displayName,
    kind: 'agent',
  })
  useUIStore.getState().requestComposerFocus()
  return { agentDisplayName: displayName }
}
