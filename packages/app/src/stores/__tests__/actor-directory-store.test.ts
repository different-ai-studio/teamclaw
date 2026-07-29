import { describe, it, expect } from 'vitest'
import { mapCacheRow } from '@/stores/actor-directory-store'

describe('mapCacheRow', () => {
  it('maps ownerMemberId from libsql cache for personal-agent delete gating', () => {
    const row = mapCacheRow({
      id: 'agent-1',
      teamId: 'team-1',
      actorType: 'agent',
      displayName: 'My Bot',
      memberStatus: null,
      agentStatus: 'active',
      lastActiveAt: null,
      teamRole: null,
      agentVisibility: 'personal',
      ownerMemberId: 'member-42',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      syncedAt: '2026-01-01T00:00:00Z',
    })

    expect(row.actor_type).toBe('agent')
    expect(row.visibility).toBe('personal')
    expect(row.owner_member_id).toBe('member-42')
  })
})
