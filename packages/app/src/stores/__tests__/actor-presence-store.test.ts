import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create, toBinary } from '@bufbuild/protobuf'
import { ActorPresenceSchema } from '@/lib/proto/amux_pb'

const mockSubscribe = vi.fn().mockResolvedValue(undefined)
let envelopeHandler: ((env: { topic: string; bytes: number[] }) => void) | null = null
const mockListen = vi.fn().mockImplementation(async (handler: (env: { topic: string; bytes: number[] }) => void) => {
  envelopeHandler = handler
  return () => { envelopeHandler = null }
})

vi.mock('@/lib/mqtt-bridge', () => ({
  mqttSubscribe: mockSubscribe,
  listenForEnvelopes: mockListen,
  mqttPublish: vi.fn(),
}))

beforeEach(() => {
  mockSubscribe.mockClear()
  envelopeHandler = null
})

afterEach(async () => {
  const mod = await import('../actor-presence-store')
  mod.disposeActorPresenceStore()
})

describe('actor-presence-store', () => {
  it('subscribes to the state wildcard for the team', async () => {
    const { initActorPresenceStore } = await import('../actor-presence-store')
    await initActorPresenceStore('team-1')
    expect(mockSubscribe).toHaveBeenCalledWith('amux/team-1/+/state')
  })

  it('decodes ActorPresence retains and upserts presence by actorId', async () => {
    const { initActorPresenceStore, useActorPresenceStore } = await import('../actor-presence-store')
    await initActorPresenceStore('team-1')

    const onlineState = create(ActorPresenceSchema, {
      online: true,
      displayName: 'Macmini',
      timestamp: 1700000000n,
    })
    envelopeHandler!({
      topic: 'amux/team-1/actor-mac/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, onlineState)),
    })

    const entry = useActorPresenceStore.getState().byActorId['actor-mac']
    expect(entry).toBeTruthy()
    expect(entry.online).toBe(true)
    expect(entry.displayName).toBe('Macmini')
  })

  it('reflects LWT offline transition', async () => {
    const { initActorPresenceStore, useActorPresenceStore } = await import('../actor-presence-store')
    await initActorPresenceStore('team-1')

    const online = create(ActorPresenceSchema, { online: true, displayName: 'Macmini', timestamp: 1n })
    envelopeHandler!({
      topic: 'amux/team-1/actor-mac/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, online)),
    })
    expect(useActorPresenceStore.getState().byActorId['actor-mac'].online).toBe(true)

    // LWT publish replaces retain with online:false.
    const offline = create(ActorPresenceSchema, { online: false, displayName: 'Macmini', timestamp: 2n })
    envelopeHandler!({
      topic: 'amux/team-1/actor-mac/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, offline)),
    })
    expect(useActorPresenceStore.getState().byActorId['actor-mac'].online).toBe(false)
  })

  it('ignores envelopes for other teams and malformed topics', async () => {
    const { initActorPresenceStore, useActorPresenceStore } = await import('../actor-presence-store')
    await initActorPresenceStore('team-1')

    const state = create(ActorPresenceSchema, { online: true })
    envelopeHandler!({
      topic: 'amux/team-2/a2/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, state)),
    })
    envelopeHandler!({ topic: 'amux/team-1/session/x/live', bytes: [1, 2, 3] })

    expect(Object.keys(useActorPresenceStore.getState().byActorId)).toHaveLength(0)
  })
})
