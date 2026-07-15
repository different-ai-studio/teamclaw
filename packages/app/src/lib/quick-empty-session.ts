import { resolveCurrentMemberActorId } from '@/lib/current-actor'
import { createSessionShell } from '@/lib/session-create'
import { ensureSessionLiveSubscribed } from '@/lib/session-live-subscriptions'
import { useAuthStore } from '@/stores/auth-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useEngagedAgentStore } from '@/stores/engaged-agent-store'
import { useSessionListStore } from '@/stores/session-list-store'
import { useSessionStore } from '@/stores/session'
import { useUIStore } from '@/stores/ui'

export type QuickEmptySessionInput = {
  additionalActorIds: string[]
  /** Session list title: "Name (HH:mm)" when set. */
  titleName: string
  /** Auto-engage in composer when exactly one agent participant. */
  engagedAgent?: { id: string; displayName: string } | null
  /** Agent actors to spawn runtimes for (fire-and-forget). */
  agentActorIdsForRuntime?: string[]
  runtimeReason?: string
}

export function soloParticipantSessionTitle(displayName: string): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  const now = new Date()
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  return `${displayName} (${hhmm})`
}

/**
 * Create an empty session shell, switch into it, and focus the composer.
 * Shared by quick local-agent chat and actor-draft "开始对话".
 */
export async function createQuickEmptySession(
  input: QuickEmptySessionInput,
): Promise<{ sessionId: string } | null> {
  const teamId = useCurrentTeamStore.getState().team?.id ?? null
  const currentMemberId = useCurrentTeamStore.getState().currentMember?.id ?? null
  const authUserId = useAuthStore.getState().session?.user?.id ?? null
  if (!teamId || !authUserId) return null

  const creatorActorId = await resolveCurrentMemberActorId(teamId, authUserId, {
    currentTeamId: teamId,
    currentMemberId,
  })
  if (!creatorActorId) return null

  const draftIdeaId = useUIStore.getState().draftIdeaId ?? null
  const { sessionId } = await createSessionShell({
    teamId,
    creatorActorId,
    title: soloParticipantSessionTitle(input.titleName),
    additionalActorIds: input.additionalActorIds,
    ideaId: draftIdeaId,
  })

  if (draftIdeaId) {
    useUIStore.getState().clearDraftIdeaId()
  }

  await ensureSessionLiveSubscribed(teamId, sessionId).catch((e) => {
    console.warn('[createQuickEmptySession] live subscribe failed (non-fatal):', e)
  })

  if (input.engagedAgent) {
    useEngagedAgentStore.getState().setAgents(sessionId, [input.engagedAgent])
  }

  await useSessionListStore.getState().load()
  useSessionStore.getState().addHighlightedSession(sessionId)
  await useUIStore.getState().switchToSession(sessionId)
  useUIStore.getState().requestComposerFocus()

  const runtimeAgentIds = input.agentActorIdsForRuntime ?? []
  if (runtimeAgentIds.length > 0) {
    void import('@/lib/teamclaw/ensure-agent-runtime').then(({ ensureAgentRuntimesForSession }) => {
      void ensureAgentRuntimesForSession({
        sessionId,
        teamId,
        agentActorIds: runtimeAgentIds,
        reason: input.runtimeReason ?? 'quick_empty_session',
      })
    })
  }

  return { sessionId }
}
