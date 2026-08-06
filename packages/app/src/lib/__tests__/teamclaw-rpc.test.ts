import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create, toBinary } from '@bufbuild/protobuf'
import { RpcResponseSchema, RuntimeStartResultSchema } from '@/lib/proto/teamclaw_pb'

const mockPublish = vi.fn().mockResolvedValue(undefined)
const mockSubscribe = vi.fn().mockResolvedValue(undefined)
let envelopeHandler: ((env: { topic: string; bytes: number[] }) => void) | null = null
const rpcLeases: Array<{ release(): void }> = []

async function acquireTeamclawRpcForTest(teamId: string, requesterActorId: string): Promise<void> {
  const { acquireTeamclawRpcBroker, acquireTeamclawRpcIdentity } = await import('../teamclaw-rpc')
  const ownerId = `test-rpc-${rpcLeases.length}`
  const identity = acquireTeamclawRpcIdentity(teamId, requesterActorId, ownerId)
  const broker = acquireTeamclawRpcBroker(teamId, requesterActorId, ownerId)
  rpcLeases.push(identity, broker)
  await Promise.all([identity.ready, broker.ready])
}
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

afterEach(() => {
  for (let index = rpcLeases.length - 1; index >= 0; index -= 1) {
    rpcLeases[index].release()
  }
  rpcLeases.length = 0
})

describe('teamclaw-rpc', () => {
  it('runtimeStart publishes RpcRequest and resolves on matching RpcResponse', async () => {
    const { runtimeStart } = await import('../teamclaw-rpc')
    await acquireTeamclawRpcForTest('team-1', 'member-1')

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
    const { runtimeStart } = await import('../teamclaw-rpc')
    await acquireTeamclawRpcForTest('team-1', 'member-1')

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
    const { runtimeStart } = await import('../teamclaw-rpc')
    await acquireTeamclawRpcForTest('team-1', 'member-1')

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

  it('keeps loopback identity and retries a transient broker setup failure', async () => {
    mockSubscribe.mockRejectedValueOnce(new Error('broker unavailable'))
    const {
      acquireTeamclawRpcBroker,
      acquireTeamclawRpcIdentity,
      isTeamclawRpcIdentityReady,
      isTeamclawRpcReady,
    } = await import('../teamclaw-rpc')

    const identity = acquireTeamclawRpcIdentity('team-1', 'member-1', 'owner-a')
    await identity.ready
    const broker = acquireTeamclawRpcBroker('team-1', 'member-1', 'owner-a')
    await broker.ready

    expect(isTeamclawRpcIdentityReady()).toBe(true)
    expect(isTeamclawRpcReady()).toBe(true)
    expect(mockSubscribe).toHaveBeenCalledTimes(2)
    broker.release()
    expect(isTeamclawRpcIdentityReady()).toBe(true)
    identity.release()
    expect(isTeamclawRpcIdentityReady()).toBe(false)
  })

  it('shares broker setup across same-context owners until the final release', async () => {
    const {
      acquireTeamclawRpcBroker,
      acquireTeamclawRpcIdentity,
      isTeamclawRpcReady,
    } = await import('../teamclaw-rpc')
    const identityA = acquireTeamclawRpcIdentity('team-1', 'member-1', 'owner-a')
    const identityB = acquireTeamclawRpcIdentity('team-1', 'member-1', 'owner-b')
    const brokerA = acquireTeamclawRpcBroker('team-1', 'member-1', 'owner-a')
    const brokerB = acquireTeamclawRpcBroker('team-1', 'member-1', 'owner-b')
    await Promise.all([identityA.ready, identityB.ready, brokerA.ready, brokerB.ready])

    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    expect(mockListen).toHaveBeenCalledTimes(1)
    brokerA.release()
    identityA.release()
    expect(isTeamclawRpcReady()).toBe(true)
    brokerB.release()
    identityB.release()
    expect(isTeamclawRpcReady()).toBe(false)
  })
})
