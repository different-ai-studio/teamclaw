import { create as createZustand } from 'zustand'
import { fromBinary } from '@bufbuild/protobuf'
import { ActorPresenceSchema } from '@/lib/proto/amux_pb'
import { mqttSubscribe, listenForEnvelopes, type IncomingEnvelope } from '@/lib/mqtt-bridge'

// Per-actor presence. Fed by retained `amux/{team}/{actor}/state` publishes —
// including the LWT the daemon registers at connect-time, which the broker
// flips to `online: false` automatically when the daemon's connection drops.
// So this store is authoritative for "is the daemon actually reachable right
// now?" — unlike `runtime-state-store`, whose retains can linger after a
// daemon dies.
//
// The topic's `{actor}` segment is the agent's `actor_id`, so callers index
// this store by the agent's actor id when they want agent presence.

export type ActorPresenceEntry = {
  online: boolean
  displayName: string
  lastUpdated: number // ms epoch
}

interface ActorPresenceState {
  byActorId: Record<string, ActorPresenceEntry>
  upsert: (actorId: string, entry: ActorPresenceEntry) => void
  clear: () => void
}

export const useActorPresenceStore = createZustand<ActorPresenceState>((set, get) => ({
  byActorId: {},
  upsert: (actorId, entry) => {
    set({
      byActorId: {
        ...get().byActorId,
        [actorId]: entry,
      },
    })
  },
  clear: () => set({ byActorId: {} }),
}))

export function parseActorStateTopic(
  topic: string,
): { teamId: string; actorId: string } | null {
  const parts = topic.split('/')
  if (parts.length !== 4) return null
  if (parts[0] !== 'amux') return null
  if (parts[3] !== 'state') return null
  return { teamId: parts[1], actorId: parts[2] }
}

let unlisten: (() => void) | null = null
let initialized = false

export async function initActorPresenceStore(teamId: string): Promise<void> {
  if (initialized) return
  await mqttSubscribe(`amux/${teamId}/+/state`)
  unlisten = await listenForEnvelopes((env: IncomingEnvelope) => {
    const parsed = parseActorStateTopic(env.topic)
    if (!parsed) return
    if (parsed.teamId !== teamId) return
    try {
      const state = fromBinary(ActorPresenceSchema, new Uint8Array(env.bytes))
      useActorPresenceStore.getState().upsert(parsed.actorId, {
        online: state.online,
        displayName: state.displayName,
        lastUpdated: Date.now(),
      })
    } catch (e) {
      console.warn('[actor-presence] failed to decode ActorPresence', e)
    }
  })
  initialized = true
}

export function disposeActorPresenceStore(): void {
  unlisten?.()
  unlisten = null
  useActorPresenceStore.getState().clear()
  initialized = false
}
