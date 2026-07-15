import { describe, expect, it } from 'vitest'
import { resolveActorOnlineStatus } from '@/lib/actor-online'

describe('resolveActorOnlineStatus', () => {
  const member = {
    id: 'member-1',
    actor_type: 'member' as const,
    last_active_at: '2020-01-01T00:00:00.000Z',
  }

  it('treats the current member as online even when last_active_at is stale', () => {
    expect(resolveActorOnlineStatus(member, { currentMemberActorId: 'member-1' })).toBe(true)
  })

  it('uses last_active_at for other members', () => {
    expect(resolveActorOnlineStatus(member, { currentMemberActorId: 'member-2' })).toBe(false)
  })

  it('prefers MQTT presence for agents', () => {
    const agent = { id: 'agent-1', actor_type: 'agent' as const, last_active_at: null }
    expect(resolveActorOnlineStatus(agent, { agentPresence: { online: true } })).toBe(true)
    expect(resolveActorOnlineStatus(agent, { agentPresence: { online: false } })).toBe(false)
  })
})
