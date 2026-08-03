import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSetModel = vi.fn().mockResolvedValue({})
const byRuntimeId: Record<string, unknown> = {}

vi.mock('@/lib/teamclaw-rpc', () => ({
  setModel: (...args: unknown[]) => mockSetModel(...args),
}))

vi.mock('@/stores/runtime-state-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/runtime-state-store')>()
  return {
    ...actual,
    useRuntimeStateStore: { getState: () => ({ byRuntimeId }) },
  }
})

/** One actor's attachment to a session, keyed the way the retain files it. */
function attach(actorId: string, sessionId: string, runtimeId: string) {
  byRuntimeId[`${actorId}::${sessionId}`] = {
    daemonActorId: actorId,
    lastUpdated: Date.now(),
    info: { runtimeId, agentType: 2, currentModel: '', availableModels: [], availableCommands: [] },
  }
}

describe('applySessionRuntimeModel', () => {
  beforeEach(() => {
    mockSetModel.mockClear()
    for (const k of Object.keys(byRuntimeId)) delete byRuntimeId[k]
  })

  it('sends setModel to each runtime in the active session', async () => {
    // Two agents on two machines, both serving this session — the case that
    // keying the store by session id alone used to collapse into one.
    attach('agent-1', 'sess-1', 'rt-1')
    attach('agent-2', 'sess-1', 'rt-2')

    const { applySessionRuntimeModel } = await import('../session-runtime-model')

    await applySessionRuntimeModel({
      sessionId: 'sess-1',
      agentActorIds: ['agent-1', 'agent-2'],
      modelId: 'claude-opus-4-7',
    })

    expect(mockSetModel).toHaveBeenCalledTimes(2)
    expect(mockSetModel).toHaveBeenCalledWith({
      targetActorId: 'agent-1',
      runtimeId: 'rt-1',
      modelId: 'claude-opus-4-7',
    })
    expect(mockSetModel).toHaveBeenCalledWith({
      targetActorId: 'agent-2',
      runtimeId: 'rt-2',
      modelId: 'claude-opus-4-7',
    })
  })

  it('targets all session runtimes when no agent ids are provided', async () => {
    attach('agent-1', 'sess-1', 'rt-1')

    const { applySessionRuntimeModel } = await import('../session-runtime-model')

    await applySessionRuntimeModel({
      sessionId: 'sess-1',
      agentActorIds: [],
      modelId: 'claude-sonnet-4-6',
    })

    expect(mockSetModel).toHaveBeenCalledWith({
      targetActorId: 'agent-1',
      runtimeId: 'rt-1',
      modelId: 'claude-sonnet-4-6',
    })
  })
})
