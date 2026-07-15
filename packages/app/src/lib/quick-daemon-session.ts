import { getLocalDaemonAgent } from '@/lib/daemon-agent-admin'
import { createQuickEmptySession } from '@/lib/quick-empty-session'
import { useCurrentTeamStore } from '@/stores/current-team'

export type QuickDaemonSessionResult = {
  sessionId: string
  agentDisplayName: string
}

/**
 * One-click session: current member + local amuxd agent, no opening message.
 * Returns null when team/auth/member/agent prerequisites are missing.
 */
export async function createQuickDaemonSession(): Promise<QuickDaemonSessionResult | null> {
  const teamId = useCurrentTeamStore.getState().team?.id ?? null
  if (!teamId) return null

  const agent = await getLocalDaemonAgent(teamId)
  if (!agent?.id) return null

  const displayName = agent.displayName || agent.id
  const created = await createQuickEmptySession({
    additionalActorIds: [agent.id],
    titleName: displayName,
    engagedAgent: { id: agent.id, displayName },
    agentActorIdsForRuntime: [agent.id],
    runtimeReason: 'quick_daemon_session',
  })

  if (!created) return null
  return { sessionId: created.sessionId, agentDisplayName: displayName }
}
