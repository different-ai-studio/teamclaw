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

/** Resolve online/offline for a directory row, overlaying MQTT agent presence. */
export function resolveActorOnlineStatus(
  actor: ActorOnlineRow,
  options: {
    currentMemberActorId?: string | null
    agentPresence?: { online: boolean } | undefined
  } = {},
): boolean {
  const isAgent = actor.actor_type === 'agent'
  if (isAgent) {
    const presence = options.agentPresence
    return presence ? presence.online : isActorOnline(actor.last_active_at)
  }
  if (options.currentMemberActorId && actor.id === options.currentMemberActorId) {
    return true
  }
  return isActorOnline(actor.last_active_at)
}
