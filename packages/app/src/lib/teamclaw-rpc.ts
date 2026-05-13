import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  RpcRequestSchema,
  RpcResponseSchema,
  RuntimeStartRequestSchema,
  RuntimeStopRequestSchema,
  SetModelRequestSchema,
  type RpcRequest,
  type RpcResponse,
  type RuntimeStartResult,
  type RuntimeStopResult,
  type SetModelResult,
} from '@/lib/proto/teamclaw_pb'
import { mqttPublish, mqttSubscribe, listenForEnvelopes, type IncomingEnvelope } from '@/lib/mqtt-bridge'
import { useAuthStore } from '@/stores/auth-store'

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

type Pending = {
  resolve: (res: RpcResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
let teamId: string | null = null
let unlisten: (() => void) | null = null
let initialized = false
const DEFAULT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Init / dispose
// ---------------------------------------------------------------------------

export async function initTeamclawRpc(teamIdArg: string): Promise<void> {
  if (initialized) return
  teamId = teamIdArg
  // Daemon publishes RPC responses to `amux/{team}/device/{daemon_device_id}/rpc/res`.
  // Subscribe with a wildcard so any daemon in the team can answer; we correlate
  // by request_id inside the response, so the device segment doesn't matter for routing.
  await mqttSubscribe(`amux/${teamIdArg}/device/+/rpc/res`)
  unlisten = await listenForEnvelopes(handleEnvelope)
  initialized = true
}

export function disposeTeamclawRpc(): void {
  unlisten?.()
  unlisten = null
  teamId = null
  for (const p of pending.values()) {
    clearTimeout(p.timer)
    p.reject(new Error('rpc disposed'))
  }
  pending.clear()
  initialized = false
}

// ---------------------------------------------------------------------------
// Envelope handler
// ---------------------------------------------------------------------------

function handleEnvelope(env: IncomingEnvelope): void {
  if (!teamId) return
  // Match `amux/{team}/device/{any}/rpc/res`.
  const expectedPrefix = `amux/${teamId}/device/`
  const expectedSuffix = `/rpc/res`
  if (!env.topic.startsWith(expectedPrefix) || !env.topic.endsWith(expectedSuffix)) return
  let response: RpcResponse
  try {
    response = fromBinary(RpcResponseSchema, new Uint8Array(env.bytes))
  } catch (e) {
    console.warn('[teamclaw-rpc] failed to decode RpcResponse', e)
    return
  }
  const p = pending.get(response.requestId)
  if (!p) {
    // Response for a request we don't own (or already timed out). Ignore quietly.
    return
  }
  pending.delete(response.requestId)
  clearTimeout(p.timer)
  p.resolve(response)
}

// ---------------------------------------------------------------------------
// Core send helper
// ---------------------------------------------------------------------------

async function sendRequest(
  build: (req: RpcRequest) => void,
  targetDeviceId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RpcResponse> {
  if (!initialized || !teamId) {
    throw new Error('teamclaw-rpc not initialized')
  }
  if (!targetDeviceId) {
    throw new Error('teamclaw-rpc: targetDeviceId required')
  }
  const requestId = crypto.randomUUID()
  const session = useAuthStore.getState().session
  const requesterActorId = session?.user?.id ?? ''
  const requesterClientId = `teamclaw-${requesterActorId.slice(0, 8)}-${requestId.slice(0, 8)}`

  const req = create(RpcRequestSchema, {
    requestId,
    requesterClientId,
    requesterActorId,
    requesterDeviceId: '', // desktop has no daemon device id of its own
  })
  build(req) // caller fills the method oneof

  return new Promise<RpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`rpc timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    pending.set(requestId, { resolve, reject, timer })

    const topic = `amux/${teamId!}/device/${targetDeviceId}/rpc/req`
    mqttPublish(topic, toBinary(RpcRequestSchema, req), false).catch((err) => {
      clearTimeout(timer)
      pending.delete(requestId)
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

// ---------------------------------------------------------------------------
// Public helper: runtimeStart
// ---------------------------------------------------------------------------

export interface RuntimeStartArgs {
  targetDeviceId: string    // daemon device_id to route the RPC to
  workspaceId: string       // supabase workspace id (or empty for bare spawn)
  worktree: string          // local path (or empty)
  sessionId: string         // supabase session id
  agentType: number         // amux.AgentType enum (e.g., AgentType.CLAUDE_CODE)
  initialPrompt?: string
  modelId?: string
  timeoutMs?: number
}

export async function runtimeStart(args: RuntimeStartArgs): Promise<RuntimeStartResult> {
  const response = await sendRequest((req) => {
    const start = create(RuntimeStartRequestSchema, {
      workspaceId: args.workspaceId,
      worktree: args.worktree,
      sessionId: args.sessionId,
      agentType: args.agentType,
      initialPrompt: args.initialPrompt ?? '',
      modelId: args.modelId ?? '',
    })
    req.method = { case: 'runtimeStart', value: start }
  }, args.targetDeviceId, args.timeoutMs)

  if (!response.success) {
    throw new Error(response.error || 'runtimeStart rejected')
  }
  if (response.result.case !== 'runtimeStartResult') {
    throw new Error(`unexpected result variant: ${response.result.case}`)
  }
  return response.result.value
}

// ---------------------------------------------------------------------------
// Public helper: runtimeStop (skeleton for M8)
// ---------------------------------------------------------------------------

export interface RuntimeStopArgs {
  targetDeviceId: string
  runtimeId: string
  timeoutMs?: number
}

export async function runtimeStop(args: RuntimeStopArgs): Promise<RuntimeStopResult> {
  const response = await sendRequest((req) => {
    const stop = create(RuntimeStopRequestSchema, { runtimeId: args.runtimeId })
    req.method = { case: 'runtimeStop', value: stop }
  }, args.targetDeviceId, args.timeoutMs)

  if (!response.success) {
    throw new Error(response.error || 'runtimeStop rejected')
  }
  if (response.result.case !== 'runtimeStopResult') {
    throw new Error(`unexpected result variant: ${response.result.case}`)
  }
  return response.result.value
}

// ---------------------------------------------------------------------------
// Public helper: setModel
// ---------------------------------------------------------------------------

export interface SetModelArgs {
  targetDeviceId: string
  runtimeId: string
  modelId: string
  timeoutMs?: number
}

export async function setModel(args: SetModelArgs): Promise<SetModelResult> {
  const response = await sendRequest((req) => {
    const sm = create(SetModelRequestSchema, {
      runtimeId: args.runtimeId,
      modelId: args.modelId,
    })
    req.method = { case: 'setModel', value: sm }
  }, args.targetDeviceId, args.timeoutMs)

  if (!response.success) {
    throw new Error(response.error || 'setModel rejected')
  }
  if (response.result.case !== 'setModelResult') {
    throw new Error(`unexpected result variant: ${response.result.case}`)
  }
  return response.result.value
}
