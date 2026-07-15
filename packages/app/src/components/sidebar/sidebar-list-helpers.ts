import type { ActorRow } from '@/components/panel/ActorsView'
import type { IdeaRow } from '@/components/panel/IdeasView'
import type { ActorPresenceEntry } from '@/stores/actor-presence-store'

export function getTopIdeas(ideas: IdeaRow[]): IdeaRow[] {
  return [...ideas]
    .sort((a, b) => {
      const bySortOrder = (a.sort_order ?? 0) - (b.sort_order ?? 0)
      if (bySortOrder !== 0) return bySortOrder
      const byUpdatedAt = b.updated_at.localeCompare(a.updated_at)
      if (byUpdatedAt !== 0) return byUpdatedAt
      return a.id.localeCompare(b.id)
    })
    .slice(0, 10)
}

export function getRecentContactActors(
  actors: ActorRow[],
  defaultAgentId?: string | null,
  presence?: Record<string, ActorPresenceEntry>,
): ActorRow[] {
  // Live presence (agents only — members don't publish MQTT state) overlays the
  // server's `last_active_at`. An online agent counts as "active now" and an
  // agent whose retained presence we just received counts from that instant —
  // so RECENTS fills/reorders the moment an agent connects, without waiting for
  // the next directory reconcile or an app restart.
  const effectiveLastActive = (actor: ActorRow): string => {
    const fromDb = actor.last_active_at ?? ''
    const p = presence?.[actor.id]
    if (!p) return fromDb
    if (p.online) return new Date().toISOString()
    const fromPresence = new Date(p.lastUpdated).toISOString()
    return fromPresence > fromDb ? fromPresence : fromDb
  }
  const isRecent = (actor: ActorRow): boolean =>
    !!actor.last_active_at || !!presence?.[actor.id]?.online

  const recents = [...actors]
    .filter(isRecent)
    .sort((a, b) => {
      const byLastActive = effectiveLastActive(b).localeCompare(effectiveLastActive(a))
      if (byLastActive !== 0) return byLastActive
      return a.display_name.localeCompare(b.display_name)
    })
    .slice(0, 20)

  if (!defaultAgentId) return recents

  // Pin the default agent to the top of Recents, even if it has no recent
  // activity (it would otherwise be filtered out for lacking last_active_at).
  const defaultAgent = actors.find(
    (actor) => actor.id === defaultAgentId && actor.actor_type === 'agent',
  )
  if (!defaultAgent) return recents
  return [defaultAgent, ...recents.filter((actor) => actor.id !== defaultAgentId)].slice(0, 20)
}
