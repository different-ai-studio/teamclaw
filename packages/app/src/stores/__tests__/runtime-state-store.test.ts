import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create, toBinary } from '@bufbuild/protobuf'
import {
  RuntimeInfoSchema,
  AgentStatus,
  AgentType,
  RuntimeLifecycle,
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
  it('subscribes to the runtime/state wildcard for the team', async () => {
    const { initRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')
    expect(mockSubscribe).toHaveBeenCalledWith('amux/team-1/+/runtime/+/state')
  })

  it('decodes RuntimeInfo retained messages and upserts into store', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    const info = create(RuntimeInfoSchema, {
      runtimeId: 'rt-1',
      agentType: AgentType.CLAUDE_CODE,
      worktree: '/tmp/x',
      status: AgentStatus.IDLE,
      state: RuntimeLifecycle.ACTIVE,
      currentModel: 'claude-opus-4-7',
    })
    envelopeHandler!({
      topic: 'amux/team-1/dev-a/runtime/rt-1/state',
      bytes: Array.from(toBinary(RuntimeInfoSchema, info)),
    })
    await flushRuntimeStateBatch()

    const entry = useRuntimeStateStore.getState().byRuntimeId['rt-1']
    expect(entry).toBeTruthy()
    expect(entry.daemonActorId).toBe('dev-a')
    expect(entry.info.runtimeId).toBe('rt-1')
    expect(entry.info.currentModel).toBe('claude-opus-4-7')
  })

  it('mirrors retain under agent actor id when topic runtime id differs', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    const info = create(RuntimeInfoSchema, {
      runtimeId: 'ff679fef',
      agentType: AgentType.OPENCODE,
      status: AgentStatus.IDLE,
      state: RuntimeLifecycle.ACTIVE,
      availableModels: [{ id: 'opencode/mimo-v2.5-free', displayName: 'Mimo' }],
    })
    envelopeHandler!({
      topic: 'amux/team-1/b3cbc44e-92fc-46c3-a5d1-27fd70bc3d83/runtime/ff679fef/state',
      bytes: Array.from(toBinary(RuntimeInfoSchema, info)),
    })
    await flushRuntimeStateBatch()

    const store = useRuntimeStateStore.getState().byRuntimeId
    expect(store['ff679fef']?.info.availableModels).toHaveLength(1)
    expect(store['b3cbc44e-92fc-46c3-a5d1-27fd70bc3d83']?.info.availableModels).toHaveLength(1)
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

    const info = create(RuntimeInfoSchema, { runtimeId: 'rt-other' })
    envelopeHandler!({
      topic: 'amux/team-2/dev-x/runtime/rt-other/state',
      bytes: Array.from(toBinary(RuntimeInfoSchema, info)),
    })
    await flushRuntimeStateBatch()

    expect(useRuntimeStateStore.getState().byRuntimeId['rt-other']).toBeUndefined()
  })

  it('batches retained RuntimeInfo bursts into one store notification', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    let notifications = 0
    const unsubscribe = useRuntimeStateStore.subscribe(() => {
      notifications += 1
    })

    const first = create(RuntimeInfoSchema, {
      runtimeId: 'rt-1',
      agentType: AgentType.CLAUDE_CODE,
      status: AgentStatus.IDLE,
      state: RuntimeLifecycle.ACTIVE,
    })
    const second = create(RuntimeInfoSchema, {
      runtimeId: 'rt-2',
      agentType: AgentType.OPENCODE,
      status: AgentStatus.RUNNING,
      state: RuntimeLifecycle.ACTIVE,
    })

    envelopeHandler!({
      topic: 'amux/team-1/dev-a/runtime/rt-1/state',
      bytes: Array.from(toBinary(RuntimeInfoSchema, first)),
    })
    envelopeHandler!({
      topic: 'amux/team-1/dev-a/runtime/rt-2/state',
      bytes: Array.from(toBinary(RuntimeInfoSchema, second)),
    })
    await flushRuntimeStateBatch()
    unsubscribe()

    const store = useRuntimeStateStore.getState().byRuntimeId
    expect(store['rt-1']?.info.runtimeId).toBe('rt-1')
    expect(store['rt-2']?.info.runtimeId).toBe('rt-2')
    expect(notifications).toBe(1)
  })

  it('refreshes the agent mirror when an unchanged retained runtime is received again', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    const valid = create(RuntimeInfoSchema, {
      runtimeId: 'rt-valid',
      agentType: AgentType.OPENCODE,
      status: AgentStatus.IDLE,
      state: RuntimeLifecycle.ACTIVE,
      currentModel: 'opencode/big-pickle',
      availableModels: [{ id: 'opencode/big-pickle', displayName: 'Big Pickle' }],
    })
    const empty = create(RuntimeInfoSchema, {
      runtimeId: 'rt-empty',
      agentType: AgentType.OPENCODE,
      status: AgentStatus.IDLE,
      state: RuntimeLifecycle.ACTIVE,
    })

    envelopeHandler!({
      topic: 'amux/team-1/agent-uuid/runtime/rt-valid/state',
      bytes: Array.from(toBinary(RuntimeInfoSchema, valid)),
    })
    await flushRuntimeStateBatch()
    await new Promise((r) => setTimeout(r, 5))

    envelopeHandler!({
      topic: 'amux/team-1/agent-uuid/runtime/rt-empty/state',
      bytes: Array.from(toBinary(RuntimeInfoSchema, empty)),
    })
    await flushRuntimeStateBatch()
    expect(useRuntimeStateStore.getState().byRuntimeId['agent-uuid'].info.runtimeId).toBe(
      'rt-empty',
    )
    await new Promise((r) => setTimeout(r, 5))

    envelopeHandler!({
      topic: 'amux/team-1/agent-uuid/runtime/rt-valid/state',
      bytes: Array.from(toBinary(RuntimeInfoSchema, valid)),
    })
    await flushRuntimeStateBatch()

    const mirror = useRuntimeStateStore.getState().byRuntimeId['agent-uuid']
    expect(mirror.info.runtimeId).toBe('rt-valid')
    expect(mirror.info.availableModels).toHaveLength(1)
  })

  it('upsert preserves entries under all spawn keys so resolver can pick newest by lastUpdated', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')

    const newer = create(RuntimeInfoSchema, {
      runtimeId: 'spawn-new',
      currentModel: 'mimo',
      availableModels: [{ id: 'mimo', displayName: 'Mimo' }],
    })
    useRuntimeStateStore.getState().upsert('spawn-new', 'agent-uuid', newer)

    await new Promise((r) => setTimeout(r, 5))

    const older = create(RuntimeInfoSchema, {
      runtimeId: 'spawn-old',
      currentModel: 'big-pickle',
      availableModels: [{ id: 'big-pickle', displayName: 'Big Pickle' }],
    })
    useRuntimeStateStore.getState().upsert('spawn-old', 'agent-uuid', older)

    // Both spawn entries are preserved so the agent-uuid resolver can pick
    // the newest by `lastUpdated` rather than depending on broker retain
    // delivery order.
    const map = useRuntimeStateStore.getState().byRuntimeId
    expect(map['spawn-new']?.info.currentModel).toBe('mimo')
    expect(map['spawn-old']?.info.currentModel).toBe('big-pickle')
    expect(map['agent-uuid']).toBeDefined()
  })

  it('upsert no longer reaches into pick-store (no circular dependency)', async () => {
    const { useRuntimeStateStore } = await import('../runtime-state-store')
    const { useAgentModelPickStore } = await import('../agent-model-pick-store')
    useAgentModelPickStore.getState().setPick('s-1', 'agent-uuid', 'mimo')

    const info = create(RuntimeInfoSchema, {
      runtimeId: 'spawn-1',
      currentModel: 'big-pickle',
      availableModels: [
        { id: 'big-pickle', displayName: 'Big Pickle' },
        { id: 'mimo', displayName: 'Mimo' },
      ],
    })
    useRuntimeStateStore.getState().upsert('spawn-1', 'agent-uuid', info)

    // The retain.currentModel in the store must reflect what the daemon
    // sent, NOT the user pick — those are reconciled at READ time by
    // selectAgentModel, never at upsert time.
    expect(useRuntimeStateStore.getState().byRuntimeId['spawn-1'].info.currentModel).toBe('big-pickle')
    expect(useRuntimeStateStore.getState().byRuntimeId['agent-uuid'].info.currentModel).toBe('big-pickle')
  })
})
