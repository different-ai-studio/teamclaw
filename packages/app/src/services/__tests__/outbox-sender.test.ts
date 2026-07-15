import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fromBinary } from '@bufbuild/protobuf'
import {
  LiveEventEnvelopeSchema,
  SessionMessageEnvelopeSchema,
} from '@/lib/proto/teamclaw_pb'

const mocks = vi.hoisted(() => ({
  mqttPublish: vi.fn(),
  insertOutgoingMessage: vi.fn(),
  upsertOutbox: vi.fn(),
  deleteOutbox: vi.fn(),
  listAllOutbox: vi.fn(),
}))

vi.mock('@/lib/mqtt-bridge', () => ({
  mqttPublish: mocks.mqttPublish,
}))

vi.mock('@/lib/backend', () => {
  class BackendError extends Error {
    category: string
    operation: string

    constructor(args: { category: string; operation: string; message: string }) {
      super(args.message)
      this.name = 'BackendError'
      this.category = args.category
      this.operation = args.operation
    }
  }

  return {
    BackendError,
    getBackend: () => ({
      messages: {
        insertOutgoingMessage: mocks.insertOutgoingMessage,
      },
      sessionMembers: {
        listParticipants: vi.fn().mockResolvedValue([
          { id: 'agent-1', actor_type: 'agent' },
        ]),
      },
    }),
  }
})

vi.mock('@/lib/teamclaw/ensure-agent-runtime', () => ({
  ensureAgentRuntimesForSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/teamclaw/resolve-runtime-start-workspace', () => ({
  resolveSessionWorkspaceHintForRuntimeStart: vi.fn().mockResolvedValue(''),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/tmp/workspace' }),
  },
}))

vi.mock('@/lib/local-cache', () => ({
  upsertOutbox: mocks.upsertOutbox,
  deleteOutbox: mocks.deleteOutbox,
  listAllOutbox: mocks.listAllOutbox,
}))

describe('outbox sender', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.mqttPublish.mockResolvedValue(undefined)
    mocks.insertOutgoingMessage.mockResolvedValue({})
    mocks.upsertOutbox.mockResolvedValue(undefined)
    mocks.deleteOutbox.mockResolvedValue(undefined)
    mocks.listAllOutbox.mockResolvedValue([])
  })

  afterEach(async () => {
    const { stopOutboxSender } = await import('../outbox-sender')
    stopOutboxSender()
  })

  it('publishes and persists the selected message model', async () => {
    const { ensureAgentRuntimesForSession } = await import('@/lib/teamclaw/ensure-agent-runtime')
    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    useOutboxStore.setState({
      byId: {
        'msg-1': {
          messageId: 'msg-1',
          teamId: 'team-1',
          sessionId: 'sess-1',
          senderActorId: 'member-1',
          content: 'hello daemon',
          model: 'opencode/qwen3.6-plus-free',
          mentionActorIds: ['agent-1'],
          displayMentionActorIds: ['agent-1'],
          attachmentUrls: [],
          workspaceIdHint: 'ws-from-enqueue',
          state: 'pending',
          attemptCount: 0,
          lastAttemptAt: null,
          nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
          lastError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    })

    startOutboxSender()

    await vi.waitFor(() => {
      expect(mocks.mqttPublish).toHaveBeenCalled()
    })

    expect(mocks.insertOutgoingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-1',
        teamId: 'team-1',
        sessionId: 'sess-1',
        senderActorId: 'member-1',
        content: 'hello daemon',
        model: 'opencode/qwen3.6-plus-free',
        metadata: expect.objectContaining({
          mention_actor_ids: ['agent-1'],
          display_mention_actor_ids: ['agent-1'],
        }),
      }),
    )

    const publishBytes = mocks.mqttPublish.mock.calls[0][1] as Uint8Array
    const live = fromBinary(LiveEventEnvelopeSchema, publishBytes)
    const sessionMessage = fromBinary(SessionMessageEnvelopeSchema, live.body)
    expect(sessionMessage.message?.model).toBe('opencode/qwen3.6-plus-free')
    expect(sessionMessage.message?.content).toBe('hello daemon')
    expect(JSON.parse(sessionMessage.message?.metadataJson ?? '{}')).toMatchObject({
      mention_actor_ids: ['agent-1'],
      display_mention_actor_ids: ['agent-1'],
    })
    // Runtime ensure now runs after the live publish as a best-effort,
    // non-blocking cold-start, so wait for it rather than asserting synchronously.
    await vi.waitFor(() => {
      expect(ensureAgentRuntimesForSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          teamId: 'team-1',
          agentActorIds: ['agent-1'],
          workspaceIdHint: 'ws-from-enqueue',
          reason: 'outbox_send',
        }),
      )
    })
  })

  it('fans out to members even when the mentioned daemon runtime cannot be ensured', async () => {
    // Daemon offline / errored: ensuring its runtime rejects. Broadcasting the
    // human's message to OTHER members must NOT depend on that — otherwise an
    // offline daemon silently swallows real-time delivery to everyone else.
    const { ensureAgentRuntimesForSession } = await import('@/lib/teamclaw/ensure-agent-runtime')
    vi.mocked(ensureAgentRuntimesForSession).mockRejectedValueOnce(
      new Error('daemon offline'),
    )

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-offline-daemon',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: '@Agent are you there',
      model: null,
      mentionActorIds: ['agent-1'],
      attachmentUrls: [],
    })

    startOutboxSender()

    // The live event must reach the session topic so other members see it.
    await vi.waitFor(() => {
      expect(mocks.mqttPublish).toHaveBeenCalled()
    })

    // And the message is considered delivered — an unreachable daemon does not
    // mark the human's message as failed/stuck.
    await vi.waitFor(() => {
      const entry = useOutboxStore.getState().byId['msg-offline-daemon']
      expect(entry.state).toBe('delivered')
      expect(entry.lastError).toBeNull()
    })
  })

  it('publishes the live event before ensuring the agent runtime', async () => {
    const order: string[] = []
    mocks.mqttPublish.mockImplementation(async () => {
      order.push('publish')
    })
    const { ensureAgentRuntimesForSession } = await import('@/lib/teamclaw/ensure-agent-runtime')
    vi.mocked(ensureAgentRuntimesForSession).mockImplementation(async () => {
      order.push('ensure')
    })

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-order',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: '@Agent hi',
      model: null,
      mentionActorIds: ['agent-1'],
      attachmentUrls: [],
    })

    startOutboxSender()

    await vi.waitFor(() => {
      expect(order).toContain('publish')
      expect(order).toContain('ensure')
    })
    expect(order.indexOf('publish')).toBeLessThan(order.indexOf('ensure'))
  })

  it('retries agent-mentioned messages when MQTT publish fails', async () => {
    mocks.mqttPublish.mockRejectedValue(new Error('mqtt not connected'))

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-1',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: '@Agent hello',
      model: null,
      mentionActorIds: ['agent-1'],
      attachmentUrls: [],
    })

    startOutboxSender()

    await vi.waitFor(() => {
      const entry = useOutboxStore.getState().byId['msg-1']
      expect(entry.state).toBe('pending')
      expect(entry.attemptCount).toBe(1)
      expect(entry.lastError).toMatch(/mqtt not connected/)
    })
  })

  it('treats backend conflicts as already delivered messages', async () => {
    const { BackendError } = await import('@/lib/backend')
    mocks.insertOutgoingMessage.mockRejectedValueOnce(new BackendError({
      category: 'Conflict',
      operation: 'messages.insertOutgoingMessage',
      message: 'duplicate key',
    }))

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-conflict',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: 'already persisted',
      model: null,
      mentionActorIds: [],
      attachmentUrls: [],
    })

    startOutboxSender()

    await vi.waitFor(() => {
      const entry = useOutboxStore.getState().byId['msg-conflict']
      expect(entry.state).toBe('delivered')
      expect(entry.lastError).toBeNull()
    })
    expect(mocks.mqttPublish).toHaveBeenCalled()
  })
})
