import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  RemoteToolInvokeResultSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  type RpcRequest,
  type RpcResponse,
} from '@/lib/proto/teamclaw_pb'
import { listenForEnvelopes, mqttPublish, mqttSubscribe, type IncomingEnvelope } from '@/lib/mqtt-bridge'

import { getExecutor } from './registry'
import { REMOTE_TOOL_ERROR } from './types'
import { authorizeRemoteToolRequest } from './validate-request'

type RpcServerState = {
  teamId: string
  actorId: string
  unlisten: (() => void) | null
}

const state: RpcServerState = {
  teamId: '',
  actorId: '',
  unlisten: null,
}

export async function initRemoteToolsRpcServer(args: {
  teamId: string
  actorId: string
}): Promise<void> {
  const teamId = args.teamId.trim()
  const actorId = args.actorId.trim()
  if (!teamId || !actorId) {
    throw new Error('remote-tools-rpc: teamId and actorId required')
  }
  if (state.unlisten && state.teamId === teamId && state.actorId === actorId) {
    return
  }
  disposeRemoteToolsRpcServer()
  state.teamId = teamId
  state.actorId = actorId
  const topic = `amux/${teamId}/${actorId}/rpc/req`
  await mqttSubscribe(topic)
  state.unlisten = await listenForEnvelopes(handleEnvelope)
}

export function disposeRemoteToolsRpcServer(): void {
  state.unlisten?.()
  state.unlisten = null
  state.teamId = ''
  state.actorId = ''
}

function handleEnvelope(env: IncomingEnvelope): void {
  const { teamId, actorId } = state
  if (!teamId || !actorId) return
  const prefix = `amux/${teamId}/`
  const suffix = '/rpc/req'
  if (!env.topic.startsWith(prefix) || !env.topic.endsWith(suffix)) return
  const parts = env.topic.split('/')
  if (parts.length !== 5 || parts[2] !== actorId) return

  void (async () => {
    let request: RpcRequest
    try {
      request = fromBinary(RpcRequestSchema, new Uint8Array(env.bytes))
    } catch {
      return
    }
    if (request.method.case !== 'remoteToolInvoke') return
    const invoke = request.method.value
    const toolName = invoke.toolName

    // Incapable clients (desktop) must skip or reply unsupported_platform so
    // daemon keeps waiting for the extension — never reply forbidden here.
    const exec = getExecutor(toolName)
    if (!exec) {
      await publishRpcResponse(
        request,
        buildRemoteToolResponse(
          request,
          false,
          '',
          REMOTE_TOOL_ERROR.unsupportedPlatform,
          `tool not supported on this client: ${toolName}`,
        ),
      )
      return
    }

    let authorized = false
    try {
      authorized = await authorizeRemoteToolRequest(teamId, request, invoke)
    } catch {
      await publishRpcResponse(
        request,
        buildRemoteToolResponse(
          request,
          false,
          '',
          REMOTE_TOOL_ERROR.forbidden,
          'remote tool request authorization failed',
        ),
      )
      return
    }

    if (!authorized) {
      await publishRpcResponse(
        request,
        buildRemoteToolResponse(
          request,
          false,
          '',
          REMOTE_TOOL_ERROR.forbidden,
          'remote tool request not allowed for this session',
        ),
      )
      return
    }

    const response = await dispatchRemoteToolInvoke(request, toolName, invoke.argumentsJson, exec)
    if (!response) return
    await publishRpcResponse(request, response)
  })()
}

async function dispatchRemoteToolInvoke(
  request: RpcRequest,
  toolName: string,
  argumentsJson: string,
  exec: NonNullable<ReturnType<typeof getExecutor>>,
): Promise<RpcResponse | null> {
  let args: Record<string, unknown> = {}
  if (argumentsJson.trim()) {
    try {
      const parsed: unknown = JSON.parse(argumentsJson)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>
      }
    } catch {
      return buildRemoteToolResponse(request, false, '', 'invalid_arguments', 'arguments_json must be a JSON object')
    }
  }

  try {
    const result = await exec(args)
    const resultJson = JSON.stringify(result ?? null)
    return buildRemoteToolResponse(request, true, resultJson, '', '')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return buildRemoteToolResponse(request, false, '', REMOTE_TOOL_ERROR.executorError, message)
  }
}

function buildRemoteToolResponse(
  request: RpcRequest,
  success: boolean,
  resultJson: string,
  errorCode: string,
  errorMessage: string,
): RpcResponse {
  return create(RpcResponseSchema, {
    requestId: request.requestId,
    success,
    error: success ? '' : errorMessage || errorCode,
    requesterClientId: request.requesterClientId,
    requesterActorId: request.requesterActorId,
    result: {
      case: 'remoteToolInvokeResult',
      value: create(RemoteToolInvokeResultSchema, {
        success,
        resultJson,
        errorCode,
        errorMessage,
      }),
    },
  })
}

async function publishRpcResponse(request: RpcRequest, response: RpcResponse): Promise<void> {
  const requester = request.requesterActorId.trim()
  if (!requester || !state.teamId) return
  const topic = `amux/${state.teamId}/${requester}/rpc/res`
  const bytes = toBinary(RpcResponseSchema, response)
  await mqttPublish(topic, bytes, false)
}
