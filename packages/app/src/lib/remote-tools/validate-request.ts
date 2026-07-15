import type { RemoteToolInvokeRequest, RpcRequest } from '@/lib/proto/teamclaw_pb'
import { useActorDirectoryStore } from '@/stores/actor-directory-store'
import { useSessionParticipantStore } from '@/stores/session-participant-store'

export function isAgentRequesterForRemoteToolRequest(
  teamId: string,
  request: RpcRequest,
): boolean {
  const requester = request.requesterActorId.trim()
  if (!requester) return false
  const actors = useActorDirectoryStore.getState().byTeam[teamId]?.actors ?? []
  const requesterRow = actors.find((a) => a.id === requester)
  return Boolean(requesterRow && requesterRow.actor_type === 'agent')
}

/**
 * Reject forged member→member rpc/req injections. Legitimate remote-tool calls
 * are published by the session's agent daemon (`requester_actor_id` = agent).
 */
export function isAllowedRemoteToolRequest(
  teamId: string,
  request: RpcRequest,
  invoke: RemoteToolInvokeRequest,
): boolean {
  const requester = request.requesterActorId.trim()
  if (!requester) return false

  const sessionId = invoke.sessionId.trim()
  if (!sessionId) return false

  if (!isAgentRequesterForRemoteToolRequest(teamId, request)) {
    return false
  }

  const participants =
    useSessionParticipantStore.getState().participantsBySession[sessionId]
  if (!participants || participants.length === 0) {
    return false
  }

  return participants.some((p) => p.actorId === requester && p.isAgent)
}
