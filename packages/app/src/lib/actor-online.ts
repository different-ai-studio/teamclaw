import { resolveAgentDevicePresenceSync } from '@/lib/agent-device-reachability'

export type ActorOnlineRow = {
  id: string
  actor_type: 'member' | 'agent'
  last_active_at: string | null
}

export function isActorOnline(lastActiveAt: string | null): boolean {
  if (!lastActiveAt) return false
  const t = Date.parse(lastActiveAt)
  if (Number.isNaN(t)) return false
  return Date.now() - t < 5 * 60 * 1000
}

/**
 * Resolve online/offline for a directory row.
 *
 * Agents use the shared device-presence merge (MQTT store + local daemon cache).
 * `agentPresence` remains as a test/fallback when the store has no retain yet.
 */
export function resolveActorOnlineStatus(
  actor: ActorOnlineRow,
  options: {
    currentMemberActorId?: string | null
    agentPresence?: { online: boolean } | undefined
  } = {},
): boolean {
  const isAgent = actor.actor_type === 'agent'
  if (isAgent) {
    const merged = resolveAgentDevicePresenceSync(actor.id)
    if (merged === 'online') return true
    if (merged === 'offline') return false
    if (options.agentPresence) return options.agentPresence.online
    return isActorOnline(actor.last_active_at)
  }
  if (options.currentMemberActorId && actor.id === options.currentMemberActorId) {
    return true
  }
  return isActorOnline(actor.last_active_at)
}
