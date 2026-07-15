import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create, toBinary } from '@bufbuild/protobuf'
import { RpcResponseSchema, RuntimeStartResultSchema } from '@/lib/proto/teamclaw_pb'

const mockPublish = vi.fn().mockResolvedValue(undefined)
const mockSubscribe = vi.fn().mockResolvedValue(undefined)
let envelopeHandler: ((env: { topic: string; bytes: number[] }) => void) | null = null
const mockListen = vi.fn().mockImplementation(async (handler: (env: { topic: string; bytes: number[] }) => void) => {
  envelopeHandler = handler
  return () => { envelopeHandler = null }
})

vi.mock('@/lib/mqtt-bridge', () => ({
  mqttPublish: mockPublish,
  mqttSubscribe: mockSubscribe,
  listenForEnvelopes: mockListen,
}))

beforeEach(() => {
  mockPublish.mockClear()
  mockSubscribe.mockClear()
  mockListen.mockClear()
})

afterEach(async () => {
  const { disposeTeamclawRpc } = await import('../teamclaw-rpc')
  disposeTeamclawRpc()
})

describe('teamclaw-rpc', () => {
  it('runtimeStart publishes RpcRequest and resolves on matching RpcResponse', async () => {
    const { initTeamclawRpc, runtimeStart } = await import('../teamclaw-rpc')
    await initTeamclawRpc('team-1', 'member-1')

    expect(mockSubscribe).toHaveBeenCalledWith('amux/team-1/+/rpc/res')

    const promise = runtimeStart({
      targetActorId: 'dev-a',
      workspaceId: 'ws-1',
      worktree: '/tmp/x',
      sessionId: 'sess-1',
      agentType: 0,
      initialPrompt: 'hello',
    })

    // mqttPublish should have been called once
    expect(mockPublish).toHaveBeenCalledTimes(1)
    const [topic, bytes] = mockPublish.mock.calls[0] as [string, Uint8Array]
    expect(topic).toBe('amux/team-1/dev-a/rpc/req')

    // Decode the request to extract its id
    const { fromBinary } = await import('@bufbuild/protobuf')
    const { RpcRequestSchema } = await import('@/lib/proto/teamclaw_pb')
    const decoded = fromBinary(RpcRequestSchema, bytes)
    const reqId = decoded.requestId
    expect(reqId).toBeTruthy()
    expect(decoded.requesterActorId).toBe('member-1')
    expect(decoded.requesterClientId).toMatch(/^teamclaw-member-1-/)
    expect(decoded.method.case).toBe('runtimeStart')

    // Simulate matching response
    const result = create(RuntimeStartResultSchema, {
      accepted: true,
      runtimeId: 'rt-1',
      sessionId: 'sess-1',
      rejectedReason: '',
    })
    const response = create(RpcResponseSchema, {
      requestId: reqId,
      success: true,
      error: '',
      result: { case: 'runtimeStartResult', value: result },
    })

    envelopeHandler!({
      topic: 'amux/team-1/dev-a/rpc/res',
      bytes: Array.from(toBinary(RpcResponseSchema, response)),
    })

    const final = await promise
    expect(final.accepted).toBe(true)
    expect(final.runtimeId).toBe('rt-1')
  })

  it('runtimeStart rejects on timeout', async () => {
    const { initTeamclawRpc, runtimeStart } = await import('../teamclaw-rpc')
    await initTeamclawRpc('team-1', 'member-1')

    const promise = runtimeStart({
      targetActorId: 'dev-a',
      workspaceId: '',
      worktree: '',
      sessionId: 'sess-1',
      agentType: 0,
      timeoutMs: 10,
    })

    await expect(promise).rejects.toThrow(/timeout/i)
  })

  it('ignores envelopes for unmatched topics', async () => {
    const { initTeamclawRpc, runtimeStart } = await import('../teamclaw-rpc')
    await initTeamclawRpc('team-1', 'member-1')

    const promise = runtimeStart({
      targetActorId: 'dev-a',
      workspaceId: '',
      worktree: '',
      sessionId: 'sess-1',
      agentType: 0,
      timeoutMs: 50,
    })

    // Wrong topic — should NOT resolve
    envelopeHandler!({ topic: 'amux/team-1/session/x/live', bytes: [1, 2, 3] })

    // Promise still pending; will timeout
    await expect(promise).rejects.toThrow(/timeout/i)
  })
})
