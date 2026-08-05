import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create, toBinary } from '@bufbuild/protobuf'
import {
  ActorPresenceSchema,
  LiveSessionSchema,
  RuntimeInfoSchema,
  AgentStatus,
  AgentType,
  RuntimeLifecycle,
  WorktreeCatalogSchema,
} from '@/lib/proto/amux_pb'

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

function flushRuntimeStateBatch(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(async () => {
  const mod = await import('../runtime-state-store')
  mod.disposeRuntimeStateStore()
})

describe('runtime-state-store', () => {
  it('subscribes only to the actor state wildcard for the team', async () => {
    const { initRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    expect(mockSubscribe).toHaveBeenCalledWith('amux/team-1/+/state')
  })

  it('decodes ActorPresence retained messages and upserts composite keys', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    const presence = create(ActorPresenceSchema, {
      online: true,
      catalogModels: [{ id: 'opencode/mimo', displayName: 'Mimo' }],
      worktrees: [
        create(WorktreeCatalogSchema, {
          worktree: '/tmp/x',
          modelIndices: [0],
          defaultModel: 'opencode/mimo',
        }),
      ],
      liveSessions: [
        create(LiveSessionSchema, {
          sessionId: 'session-1',
          currentModel: 'opencode/mimo',
          lifecycle: RuntimeLifecycle.ACTIVE,
          status: AgentStatus.IDLE,
          worktree: '/tmp/x',
        }),
      ],
    })
    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, presence)),
    })
    await flushRuntimeStateBatch()

    const entry = useRuntimeStateStore.getState().byRuntimeId['dev-a::session-1']
    expect(entry).toBeTruthy()
    expect(entry.daemonActorId).toBe('dev-a')
    expect(entry.info.runtimeId).toBe('session-1')
    expect(entry.info.currentModel).toBe('opencode/mimo')
  })

  it('stores default workspace catalog from ActorPresence', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    const presence = create(ActorPresenceSchema, {
      online: true,
      defaultWorkspaceId: 'ws-default',
      defaultWorktree: '/tmp/default',
      defaultWorkspaceModels: [{ id: 'shopee/gpt-5.5', displayName: 'gpt-5.5' }],
    })
    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, presence)),
    })
    await flushRuntimeStateBatch()

    const entry = useRuntimeStateStore.getState().defaultCatalogByActorId['dev-a']
    expect(entry?.defaultWorkspaceId).toBe('ws-default')
    expect(entry?.defaultWorktree).toBe('/tmp/default')
    expect(entry?.models.map((m) => m.id)).toEqual(['shopee/gpt-5.5'])
  })

  it('ignores legacy per-runtime topics', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    const info = create(RuntimeInfoSchema, {
      runtimeId: 'rt-1',
      agentType: AgentType.CLAUDE_CODE,
      status: AgentStatus.IDLE,
      state: RuntimeLifecycle.ACTIVE,
    })
    envelopeHandler!({
      topic: 'amux/team-1/dev-a/runtime/rt-1/state',
      bytes: Array.from(toBinary(RuntimeInfoSchema, info)),
    })
    await flushRuntimeStateBatch()

    expect(Object.keys(useRuntimeStateStore.getState().byRuntimeId)).toHaveLength(0)
  })

  it('ignores envelopes with malformed topics', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    envelopeHandler!({ topic: 'amux/team-1/session/x/live', bytes: [1, 2, 3] })
    envelopeHandler!({ topic: 'unrelated', bytes: [1] })
    await flushRuntimeStateBatch()

    expect(Object.keys(useRuntimeStateStore.getState().byRuntimeId)).toHaveLength(0)
  })

  it('ignores envelopes for other teams', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    const presence = create(ActorPresenceSchema, {
      liveSessions: [create(LiveSessionSchema, { sessionId: 'session-other', worktree: '/tmp/x' })],
    })
    envelopeHandler!({
      topic: 'amux/team-2/dev-x/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, presence)),
    })
    await flushRuntimeStateBatch()

    expect(useRuntimeStateStore.getState().byRuntimeId['dev-x::session-other']).toBeUndefined()
  })

  it('batches actor state bursts into one store notification', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    let notifications = 0
    const unsubscribe = useRuntimeStateStore.subscribe(() => {
      notifications += 1
    })

    const presence = create(ActorPresenceSchema, {
      liveSessions: [
        create(LiveSessionSchema, { sessionId: 'session-1', worktree: '/w' }),
        create(LiveSessionSchema, { sessionId: 'session-2', worktree: '/w' }),
      ],
    })

    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(toBinary(ActorPresenceSchema, presence)),
    })
    await flushRuntimeStateBatch()
    unsubscribe()

    const store = useRuntimeStateStore.getState().byRuntimeId
    expect(store['dev-a::session-1']).toBeTruthy()
    expect(store['dev-a::session-2']).toBeTruthy()
    expect(notifications).toBe(1)
  })

  it('upsert preserves entries under distinct composite keys', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')

    useRuntimeStateStore.getState().upsert(
      'agent-uuid::session-a',
      'agent-uuid',
      create(RuntimeInfoSchema, {
        runtimeId: 'session-a',
        currentModel: 'mimo',
        availableModels: [{ id: 'mimo', displayName: 'Mimo' }],
      }),
    )

    useRuntimeStateStore.getState().upsert(
      'agent-uuid::session-b',
      'agent-uuid',
      create(RuntimeInfoSchema, {
        runtimeId: 'session-b',
        currentModel: 'big-pickle',
        availableModels: [{ id: 'big-pickle', displayName: 'Big Pickle' }],
      }),
    )

    const map = useRuntimeStateStore.getState().byRuntimeId
    expect(map['agent-uuid::session-a']?.info.currentModel).toBe('mimo')
    expect(map['agent-uuid::session-b']?.info.currentModel).toBe('big-pickle')
    expect(map['agent-uuid']).toBeUndefined()
  })

  it('upsert no longer reaches into pick-store (no circular dependency)', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')
    const { useAgentModelPickStore } = await import('../agent-model-pick-store')
    useAgentModelPickStore.getState().setPick('s-1', 'agent-uuid', 'mimo')

    const info = create(RuntimeInfoSchema, {
      runtimeId: 'session-1',
      currentModel: 'big-pickle',
      availableModels: [
        { id: 'big-pickle', displayName: 'Big Pickle' },
        { id: 'mimo', displayName: 'Mimo' },
      ],
    })
    useRuntimeStateStore.getState().upsert('agent-uuid::session-1', 'agent-uuid', info)

    expect(useRuntimeStateStore.getState().byRuntimeId['agent-uuid::session-1'].info.currentModel).toBe(
      'big-pickle',
    )
  })

  it('prunes detached sessions when live_sessions shrinks', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(
        toBinary(
          ActorPresenceSchema,
          create(ActorPresenceSchema, {
            liveSessions: [
              create(LiveSessionSchema, { sessionId: 'session-1', worktree: '/tmp/x' }),
              create(LiveSessionSchema, { sessionId: 'session-2', worktree: '/tmp/x' }),
            ],
          }),
        ),
      ),
    })
    await flushRuntimeStateBatch()

    expect(useRuntimeStateStore.getState().byRuntimeId['dev-a::session-1']).toBeTruthy()
    expect(useRuntimeStateStore.getState().byRuntimeId['dev-a::session-2']).toBeTruthy()

    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(
        toBinary(
          ActorPresenceSchema,
          create(ActorPresenceSchema, {
            liveSessions: [
              create(LiveSessionSchema, { sessionId: 'session-1', worktree: '/tmp/x' }),
            ],
          }),
        ),
      ),
    })
    await flushRuntimeStateBatch()

    const store = useRuntimeStateStore.getState().byRuntimeId
    expect(store['dev-a::session-1']).toBeTruthy()
    expect(store['dev-a::session-2']).toBeUndefined()
  })

  it('clears all actor attachments when live_sessions is empty', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(
        toBinary(
          ActorPresenceSchema,
          create(ActorPresenceSchema, {
            liveSessions: [
              create(LiveSessionSchema, { sessionId: 'session-1', worktree: '/tmp/x' }),
            ],
          }),
        ),
      ),
    })
    await flushRuntimeStateBatch()
    expect(useRuntimeStateStore.getState().byRuntimeId['dev-a::session-1']).toBeTruthy()

    envelopeHandler!({
      topic: 'amux/team-1/dev-a/state',
      bytes: Array.from(
        toBinary(
          ActorPresenceSchema,
          create(ActorPresenceSchema, { liveSessions: [] }),
        ),
      ),
    })
    await flushRuntimeStateBatch()
    expect(useRuntimeStateStore.getState().byRuntimeId['dev-a::session-1']).toBeUndefined()
  })

  it('preserves catalog when a partial retain arrives without available_models', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')

    useRuntimeStateStore.getState().upsert(
      'agent-uuid::session-1',
      'agent-uuid',
      create(RuntimeInfoSchema, {
        runtimeId: 'session-1',
        state: RuntimeLifecycle.ACTIVE,
        availableModels: [{ id: 'mimo', displayName: 'Mimo' }],
      }),
    )

    useRuntimeStateStore.getState().upsert(
      'agent-uuid::session-1',
      'agent-uuid',
      create(RuntimeInfoSchema, {
        runtimeId: 'session-1',
        state: RuntimeLifecycle.ACTIVE,
        availableModels: [],
      }),
    )

    expect(
      useRuntimeStateStore.getState().byRuntimeId['agent-uuid::session-1']?.info.availableModels,
    ).toHaveLength(1)
  })
})
