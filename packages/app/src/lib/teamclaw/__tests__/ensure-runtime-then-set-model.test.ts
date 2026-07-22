import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startAgentRuntimesAsync: vi.fn(),
  setModel: vi.fn(),
  waitForTeamclawRpcReady: vi.fn(),
  resolveAgentDevicePresence: vi.fn(),
  listParticipants: vi.fn(),
  addParticipant: vi.fn(),
  resolveSessionWorkspaceHintForRuntimeStart: vi.fn(),
  mqttConnected: true as boolean | null,
}))

vi.mock('@/lib/session-create', () => ({
  startAgentRuntimesAsync: (...args: unknown[]) => mocks.startAgentRuntimesAsync(...args),
}))

vi.mock('@/lib/teamclaw-rpc', () => ({
  setModel: (...args: unknown[]) => mocks.setModel(...args),
  waitForTeamclawRpcReady: (...args: unknown[]) => mocks.waitForTeamclawRpcReady(...args),
}))

vi.mock('@/lib/agent-device-reachability', () => ({
  resolveAgentDevicePresence: (...args: unknown[]) => mocks.resolveAgentDevicePresence(...args),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    sessionMembers: {
      listParticipants: (...args: unknown[]) => mocks.listParticipants(...args),
      addParticipant: (...args: unknown[]) => mocks.addParticipant(...args),
    },
  }),
}))

vi.mock('@/lib/teamclaw/resolve-runtime-start-workspace', () => ({
  resolveSessionWorkspaceHintForRuntimeStart: (...args: unknown[]) =>
    mocks.resolveSessionWorkspaceHintForRuntimeStart(...args),
}))

vi.mock('@/stores/mqtt-reconnect', () => ({
  useMqttReconnectStore: {
    getState: () => ({ connected: mocks.mqttConnected }),
  },
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/tmp/ws' }),
  },
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
}))

vi.mock('@/lib/i18n', () => ({
  default: { t: (_k: string, fallback?: string) => fallback ?? _k },
}))

describe('ensureRuntimeThenSetModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mqttConnected = true
    mocks.waitForTeamclawRpcReady.mockResolvedValue(true)
    mocks.resolveAgentDevicePresence.mockResolvedValue('online')
    mocks.listParticipants.mockResolvedValue([{ id: 'agent-1' }])
    mocks.resolveSessionWorkspaceHintForRuntimeStart.mockResolvedValue('ws-1')
    mocks.startAgentRuntimesAsync.mockResolvedValue({
      failures: [],
      runtimeIdsByAgent: { 'agent-1': 'spawn-live' },
    })
    mocks.setModel.mockResolvedValue({ success: true })
  })

  it('runtimeStarts then setModels with the daemon-returned spawn id', async () => {
    const { ensureRuntimeThenSetModel } = await import('../ensure-agent-runtime')
    const result = await ensureRuntimeThenSetModel({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorId: 'agent-1',
      modelId: 'opencode/big-pickle',
    })

    expect(result).toEqual({ runtimeId: 'spawn-live' })
    expect(mocks.startAgentRuntimesAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        teamId: 'team-1',
        agentActorIds: ['agent-1'],
        modelId: 'opencode/big-pickle',
        skipModelApply: true,
      }),
    )
    expect(mocks.setModel).toHaveBeenCalledWith({
      targetActorId: 'agent-1',
      runtimeId: 'spawn-live',
      modelId: 'opencode/big-pickle',
      timeoutMs: expect.any(Number),
    })
  })

  it('throws when runtimeStart fails instead of guessing a stale spawn id', async () => {
    mocks.startAgentRuntimesAsync.mockResolvedValue({
      failures: [{ agentActorId: 'agent-1', code: 'runtime_rejected', reason: 'daemon busy' }],
      runtimeIdsByAgent: {},
    })

    const { ensureRuntimeThenSetModel } = await import('../ensure-agent-runtime')
    await expect(
      ensureRuntimeThenSetModel({
        sessionId: 'sess-1',
        teamId: 'team-1',
        agentActorId: 'agent-1',
        modelId: 'opencode/big-pickle',
      }),
    ).rejects.toThrow('daemon busy')
    expect(mocks.setModel).not.toHaveBeenCalled()
  })

  it('throws when mqtt is disconnected', async () => {
    mocks.mqttConnected = false
    const { ensureRuntimeThenSetModel } = await import('../ensure-agent-runtime')
    await expect(
      ensureRuntimeThenSetModel({
        sessionId: 'sess-1',
        teamId: 'team-1',
        agentActorId: 'agent-1',
        modelId: 'opencode/big-pickle',
      }),
    ).rejects.toThrow('mqtt disconnected')
    expect(mocks.startAgentRuntimesAsync).not.toHaveBeenCalled()
  })
})
