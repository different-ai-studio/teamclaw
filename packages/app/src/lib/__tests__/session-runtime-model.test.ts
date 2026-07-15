import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSetModel = vi.fn().mockResolvedValue({})
const listRuntimeTargetsForSession = vi.fn()

vi.mock('@/lib/teamclaw-rpc', () => ({
  setModel: (...args: unknown[]) => mockSetModel(...args),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    runtime: { listRuntimeTargetsForSession },
  }),
}))

describe('applySessionRuntimeModel', () => {
  beforeEach(() => {
    mockSetModel.mockClear()
    listRuntimeTargetsForSession.mockReset()
  })

  it('sends setModel to each runtime in the active session', async () => {
    listRuntimeTargetsForSession.mockResolvedValue([
      { agent_id: 'agent-1', runtime_id: 'rt-1' },
      { agent_id: 'agent-2', runtime_id: 'rt-2' },
    ])

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
    listRuntimeTargetsForSession.mockResolvedValue([
      { agent_id: 'agent-1', runtime_id: 'rt-1' },
    ])

    const { applySessionRuntimeModel } = await import('../session-runtime-model')

    await applySessionRuntimeModel({
      sessionId: 'sess-1',
      agentActorIds: [],
      modelId: 'claude-sonnet-4-6',
    })

    expect(listRuntimeTargetsForSession).toHaveBeenCalledWith('sess-1', [])
    expect(mockSetModel).toHaveBeenCalledWith({
      targetActorId: 'agent-1',
      runtimeId: 'rt-1',
      modelId: 'claude-sonnet-4-6',
    })
  })
})
