import { describe, expect, it } from 'vitest'
import type { ActorRow } from '@/components/panel/ActorsView'
import type { IdeaRow } from '@/components/panel/IdeasView'
import { getRecentContactActors, getTopIdeas } from '../sidebar-list-helpers'

function idea(id: string, sortOrder: number, updatedAt = '2026-05-01T00:00:00Z'): IdeaRow {
  return {
    id,
    title: id,
    status: 'open',
    created_by_actor_id: 'actor-1',
    sort_order: sortOrder,
    updated_at: updatedAt,
  }
}

function actor(id: string, lastActiveAt: string | null): ActorRow {
  return {
    id,
    actor_type: 'member',
    display_name: id,
    member_status: null,
    agent_status: null,
    last_active_at: lastActiveAt,
  }
}

function agent(id: string, lastActiveAt: string | null): ActorRow {
  return { ...actor(id, lastActiveAt), actor_type: 'agent' }
}

describe('sidebar list helpers', () => {
  it('returns the top 10 ideas by highest rank', () => {
    const ideas = Array.from({ length: 12 }, (_, index) =>
      idea(`idea-${index + 1}`, (12 - index) * 1000),
    )

    expect(getTopIdeas(ideas).map((row) => row.id)).toEqual([
      'idea-12',
      'idea-11',
      'idea-10',
      'idea-9',
      'idea-8',
      'idea-7',
      'idea-6',
      'idea-5',
      'idea-4',
      'idea-3',
    ])
  })

  it('returns at most 20 actors with recent contact first', () => {
    const actors = [
      actor('never-contacted', null),
      ...Array.from({ length: 22 }, (_, index) =>
        actor(`actor-${index + 1}`, `2026-05-${String(index + 1).padStart(2, '0')}T00:00:00Z`),
      ),
    ]

    const rows = getRecentContactActors(actors)

    expect(rows).toHaveLength(20)
    expect(rows[0].id).toBe('actor-22')
    expect(rows.at(-1)?.id).toBe('actor-3')
    expect(rows.some((row) => row.id === 'never-contacted')).toBe(false)
  })

  it('pins the default agent to the top even with no recent activity', () => {
    const actors = [
      agent('default-bot', null),
      ...Array.from({ length: 5 }, (_, index) =>
        actor(`actor-${index + 1}`, `2026-05-0${index + 1}T00:00:00Z`),
      ),
    ]

    const rows = getRecentContactActors(actors, 'default-bot')

    expect(rows[0].id).toBe('default-bot')
    // The default agent appears exactly once (not duplicated).
    expect(rows.filter((row) => row.id === 'default-bot')).toHaveLength(1)
  })

  it('moves an already-recent default agent to the top without duplicating it', () => {
    const actors = [
      actor('actor-late', '2026-05-09T00:00:00Z'),
      agent('default-bot', '2026-05-01T00:00:00Z'),
      actor('actor-mid', '2026-05-05T00:00:00Z'),
    ]

    const rows = getRecentContactActors(actors, 'default-bot')

    expect(rows[0].id).toBe('default-bot')
    expect(rows.filter((row) => row.id === 'default-bot')).toHaveLength(1)
    expect(rows).toHaveLength(3)
  })

  it('ignores a default id that is not an agent in the list', () => {
    const actors = [actor('actor-1', '2026-05-01T00:00:00Z')]
    expect(getRecentContactActors(actors, 'missing').map((r) => r.id)).toEqual(['actor-1'])
  })
})
