import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSubscribe, mockPublish, mockListen, mockEnsureParticipants, mockListParticipants } = vi.hoisted(() => ({
  mockSubscribe: vi.fn(async () => undefined),
  mockPublish: vi.fn(async () => undefined),
  mockListen: vi.fn(async () => () => undefined),
  mockEnsureParticipants: vi.fn(async () => undefined),
  mockListParticipants: vi.fn(async () => []),
}))

vi.mock('@/lib/mqtt-bridge', () => ({
  mqttSubscribe: mockSubscribe,
  mqttPublish: mockPublish,
  listenForEnvelopes: mockListen,
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    actors: {
      getActorDirectoryEntry: vi.fn(async () => null),
    },
    sessionMembers: {
      listParticipants: mockListParticipants,
    },
  }),
}))

vi.mock('@/stores/actor-directory-store', () => ({
  useActorDirectoryStore: {
    getState: () => ({
      byTeam: {
        'team-1': {
          actors: [
            {
              id: 'daemon-1',
              actor_type: 'agent',
              display_name: 'Daemon',
              member_status: null,
              agent_status: 'active',
              last_active_at: null,
            },
          ],
        },
      },
    }),
  },
}))

vi.mock('@/stores/session-participant-store', () => ({
  useSessionParticipantStore: {
    getState: () => ({
      participantsBySession: {
        'sess-1': [
          {
            actorId: 'daemon-1',
            displayName: 'Daemon',
            avatarUrl: null,
            isAgent: true,
          },
        ],
      },
      ensureParticipants: mockEnsureParticipants,
    }),
  },
}))

import { create, toBinary } from '@bufbuild/protobuf'
import {
  RemoteToolInvokeRequestSchema,
  RpcRequestSchema,
} from '@/lib/proto/teamclaw_pb'

import { clearExecutorsForTests, registerExecutor } from './registry'
import { disposeRemoteToolsRpcServer, initRemoteToolsRpcServer } from './rpc-server'
import { TOOL_GET_PAGE_DOM } from './types'

describe('remote-tools rpc-server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    disposeRemoteToolsRpcServer()
    clearExecutorsForTests()
  })

  it('subscribes to actor rpc/req on init', async () => {
    await initRemoteToolsRpcServer({ teamId: 'team-1', actorId: 'actor-1' })
    expect(mockSubscribe).toHaveBeenCalledWith('amux/team-1/actor-1/rpc/req')
  })

  it('replies unsupported_platform when executor missing', async () => {
    let handler: ((env: { topic: string; bytes: ArrayBuffer }) => void) | undefined
    mockListen.mockImplementation(async (fn) => {
      handler = fn
      return () => undefined
    })

    await initRemoteToolsRpcServer({ teamId: 'team-1', actorId: 'actor-1' })

    const request = create(RpcRequestSchema, {
      requestId: 'req-1',
      requesterActorId: 'daemon-1',
      method: {
        case: 'remoteToolInvoke',
        value: create(RemoteToolInvokeRequestSchema, {
          sessionId: 'sess-1',
          toolName: TOOL_GET_PAGE_DOM,
          argumentsJson: '{}',
        }),
      },
    })

    handler?.({
      topic: 'amux/team-1/actor-1/rpc/req',
      bytes: toBinary(RpcRequestSchema, request).buffer,
    })

    await vi.waitFor(() => expect(mockPublish).toHaveBeenCalled())
    expect(mockEnsureParticipants).not.toHaveBeenCalled()
    const text = new TextDecoder().decode(mockPublish.mock.calls[0][1] as Uint8Array)
    expect(text).toContain('unsupported_platform')
  })

  it('replies forbidden when executor exists but request is not allowed', async () => {
    registerExecutor(TOOL_GET_PAGE_DOM, async () => ({ ok: true }))
    let handler: ((env: { topic: string; bytes: ArrayBuffer }) => void) | undefined
    mockListen.mockImplementation(async (fn) => {
      handler = fn
      return () => undefined
    })

    await initRemoteToolsRpcServer({ teamId: 'team-1', actorId: 'actor-1' })

    const request = create(RpcRequestSchema, {
      requestId: 'req-forbidden',
      requesterActorId: 'daemon-1',
      method: {
        case: 'remoteToolInvoke',
        value: create(RemoteToolInvokeRequestSchema, {
          sessionId: 'sess-unknown',
          toolName: TOOL_GET_PAGE_DOM,
          argumentsJson: '{}',
        }),
      },
    })

    handler?.({
      topic: 'amux/team-1/actor-1/rpc/req',
      bytes: toBinary(RpcRequestSchema, request).buffer,
    })

    await vi.waitFor(() => expect(mockPublish).toHaveBeenCalled())
    expect(mockEnsureParticipants).toHaveBeenCalledWith(['sess-unknown'])
    const text = new TextDecoder().decode(mockPublish.mock.calls[0][1] as Uint8Array)
    expect(text).toContain('forbidden')
  })

  it('replies forbidden when authorization throws', async () => {
    registerExecutor(TOOL_GET_PAGE_DOM, async () => ({ ok: true }))
    mockEnsureParticipants.mockRejectedValueOnce(new Error('participants unavailable'))
    let handler: ((env: { topic: string; bytes: ArrayBuffer }) => void) | undefined
    mockListen.mockImplementation(async (fn) => {
      handler = fn
      return () => undefined
    })

    await initRemoteToolsRpcServer({ teamId: 'team-1', actorId: 'actor-1' })

    const request = create(RpcRequestSchema, {
      requestId: 'req-auth-error',
      requesterActorId: 'daemon-1',
      method: {
        case: 'remoteToolInvoke',
        value: create(RemoteToolInvokeRequestSchema, {
          sessionId: 'sess-1',
          toolName: TOOL_GET_PAGE_DOM,
          argumentsJson: '{}',
        }),
      },
    })

    handler?.({
      topic: 'amux/team-1/actor-1/rpc/req',
      bytes: toBinary(RpcRequestSchema, request).buffer,
    })

    await vi.waitFor(() => expect(mockPublish).toHaveBeenCalled())
    const text = new TextDecoder().decode(mockPublish.mock.calls[0][1] as Uint8Array)
    expect(text).toContain('forbidden')
    expect(text).toContain('remote tool request authorization failed')
  })

  it('dispatches to registered executor', async () => {
    registerExecutor(TOOL_GET_PAGE_DOM, async () => ({ ok: true }))
    let handler: ((env: { topic: string; bytes: ArrayBuffer }) => void) | undefined
    mockListen.mockImplementation(async (fn) => {
      handler = fn
      return () => undefined
    })

    await initRemoteToolsRpcServer({ teamId: 'team-1', actorId: 'actor-1' })

    const request = create(RpcRequestSchema, {
      requestId: 'req-2',
      requesterActorId: 'daemon-1',
      method: {
        case: 'remoteToolInvoke',
        value: create(RemoteToolInvokeRequestSchema, {
          sessionId: 'sess-1',
          toolName: TOOL_GET_PAGE_DOM,
          argumentsJson: '{"mode":"outline"}',
        }),
      },
    })

    handler?.({
      topic: 'amux/team-1/actor-1/rpc/req',
      bytes: toBinary(RpcRequestSchema, request).buffer,
    })

    await vi.waitFor(() => expect(mockPublish).toHaveBeenCalled())
    expect(mockEnsureParticipants).toHaveBeenCalledWith(['sess-1'])
    const text = new TextDecoder().decode(mockPublish.mock.calls[0][1] as Uint8Array)
    expect(text).toContain('"ok":true')
  })

  it('rejects non-agent requester before loading participants', async () => {
    registerExecutor(TOOL_GET_PAGE_DOM, async () => ({ ok: true }))
    let handler: ((env: { topic: string; bytes: ArrayBuffer }) => void) | undefined
    mockListen.mockImplementation(async (fn) => {
      handler = fn
      return () => undefined
    })

    await initRemoteToolsRpcServer({ teamId: 'team-1', actorId: 'actor-1' })

    const request = create(RpcRequestSchema, {
      requestId: 'req-3',
      requesterActorId: 'member-1',
      method: {
        case: 'remoteToolInvoke',
        value: create(RemoteToolInvokeRequestSchema, {
          sessionId: 'sess-1',
          toolName: TOOL_GET_PAGE_DOM,
          argumentsJson: '{}',
        }),
      },
    })

    handler?.({
      topic: 'amux/team-1/actor-1/rpc/req',
      bytes: toBinary(RpcRequestSchema, request).buffer,
    })

    await new Promise((r) => setTimeout(r, 20))
    expect(mockEnsureParticipants).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(mockPublish).toHaveBeenCalled())
    const text = new TextDecoder().decode(mockPublish.mock.calls[0][1] as Uint8Array)
    expect(text).toContain('forbidden')
  })
})
