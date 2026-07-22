import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  FetchWorkspacesRequestSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  RuntimeStartRequestSchema,
  RuntimeStopRequestSchema,
  SetModelRequestSchema,
  type FetchWorkspacesResult,
  type RpcRequest,
  type RpcResponse,
  type RuntimeStartResult,
  type RuntimeStopResult,
  type SetModelResult,
} from '@/lib/proto/teamclaw_pb'
import { mqttPublish, mqttSubscribe, listenForEnvelopes, type IncomingEnvelope } from '@/lib/mqtt-bridge'
import { recordMqttDiag } from '@/lib/mqtt-diagnostics'
import { getKnownLocalDaemonActorId } from '@/lib/local-daemon-identity'
import { resolveAgentDevicePresenceSync } from '@/lib/agent-device-reachability'
import { isTauri } from '@/lib/utils'

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
let requesterActorId: string | null = null
let unlisten: (() => void) | null = null
let initialized = false
const DEFAULT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Init / dispose
// ---------------------------------------------------------------------------

export function isTeamclawRpcReady(): boolean {
  return initialized && teamId !== null && requesterActorId !== null
}

/** Poll until MQTT RPC listener is wired (App.tsx init), or timeout. */
export async function waitForTeamclawRpcReady(timeoutMs = 15_000): Promise<boolean> {
  if (isTeamclawRpcReady()) {
    recordMqttDiag('teamclaw-rpc', 'wait-ready:already-ready', { timeoutMs, teamId })
    return true
  }
  recordMqttDiag('teamclaw-rpc', 'wait-ready:begin', { timeoutMs, teamId, initialized })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    if (isTeamclawRpcReady()) {
      recordMqttDiag('teamclaw-rpc', 'wait-ready:ok', { timeoutMs, teamId })
      return true
    }
  }
  recordMqttDiag('teamclaw-rpc', 'wait-ready:timeout', { timeoutMs, teamId, initialized })
  return isTeamclawRpcReady()
}

export async function initTeamclawRpc(teamIdArg: string, requesterActorIdArg: string): Promise<void> {
  const trimmedRequesterActorId = requesterActorIdArg.trim()
  if (!trimmedRequesterActorId) {
    throw new Error('teamclaw-rpc: requesterActorId required')
  }
  if (initialized) {
    recordMqttDiag('teamclaw-rpc', 'init:skip-already-initialized', {
      existingTeamId: teamId,
      requestedTeamId: teamIdArg,
      requesterActorId,
      requestedRequesterActorId: trimmedRequesterActorId,
    })
    return
  }
  teamId = teamIdArg
  requesterActorId = trimmedRequesterActorId
  // Daemon publishes RPC responses to `amux/{team}/{daemon_actor_id}/rpc/res`.
  // Subscribe with a wildcard so any daemon in the team can answer; we correlate
  // by request_id inside the response, so the actor segment doesn't matter for routing.
  recordMqttDiag('teamclaw-rpc', 'init:subscribe-before', { topic: `amux/${teamIdArg}/+/rpc/res` })
  await mqttSubscribe(`amux/${teamIdArg}/+/rpc/res`)
  recordMqttDiag('teamclaw-rpc', 'init:subscribe-ok', { topic: `amux/${teamIdArg}/+/rpc/res` })
  unlisten = await listenForEnvelopes(handleEnvelope)
  initialized = true
  recordMqttDiag('teamclaw-rpc', 'init:ready', { teamId, requesterActorId })
}

export function disposeTeamclawRpc(): void {
  recordMqttDiag('teamclaw-rpc', 'dispose', { teamId, pending: pending.size, initialized })
  unlisten?.()
  unlisten = null
  teamId = null
  requesterActorId = null
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
  // Match `amux/{team}/{any}/rpc/res`.
  const expectedPrefix = `amux/${teamId}/`
  const expectedSuffix = `/rpc/res`
  if (!env.topic.startsWith(expectedPrefix) || !env.topic.endsWith(expectedSuffix)) return
  recordMqttDiag('teamclaw-rpc', 'response:received', { topic: env.topic, bytes: env.bytes.byteLength })
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
    recordMqttDiag('teamclaw-rpc', 'response:no-pending', {
      topic: env.topic,
      requestId: response.requestId,
      success: response.success,
      resultCase: response.result.case,
    })
    return
  }
  pending.delete(response.requestId)
  clearTimeout(p.timer)
  recordMqttDiag('teamclaw-rpc', 'response:matched', {
    topic: env.topic,
    requestId: response.requestId,
    success: response.success,
    resultCase: response.result.case,
    pending: pending.size,
  })
  p.resolve(response)
}

// ---------------------------------------------------------------------------
// Local HTTP fast path (Tauri only)
// ---------------------------------------------------------------------------
//
// When the target actor is this machine's amuxd daemon, commands go over
// loopback HTTP (`POST /v1/rpc` via the `daemon_rpc` Tauri command) instead
// of round-tripping through the cloud EMQX broker. Any local failure falls
// back to the MQTT path transparently and pauses the fast path for a cooldown
// window so a down daemon doesn't add per-request latency (no flapping).
// Browser builds and remote agents always use MQTT — behavior unchanged.

const LOCAL_RPC_TIMEOUT_MS = 10_000
const LOCAL_RPC_FAILURE_COOLDOWN_MS = 30_000
let localRpcFailedUntil = 0

/** @internal test hook */
export function __resetLocalRpcFailureForTest(): void {
  localRpcFailedUntil = 0
}

function shouldTryLocalRpc(targetActorId: string): boolean {
  if (!isTauri()) return false
  if (Date.now() < localRpcFailedUntil) return false
  const localActorId = getKnownLocalDaemonActorId()
  if (!localActorId || localActorId !== targetActorId) return false
  // Cached device-presence signal (local HTTP probe + daemon MQTT link, 5s
  // TTL). "offline" means the local daemon is known-unreachable right now;
  // skip straight to MQTT without burning the HTTP timeout.
  return resolveAgentDevicePresenceSync(targetActorId) !== 'offline'
}

function noteLocalRpcFailure(): void {
  localRpcFailedUntil = Date.now() + LOCAL_RPC_FAILURE_COOLDOWN_MS
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function sendViaLocalHttp(req: RpcRequest): Promise<RpcResponse> {
  const { invoke } = await import('@tauri-apps/api/core')
  const payloadB64 = bytesToBase64(toBinary(RpcRequestSchema, req))
  const replyB64 = await Promise.race([
    invoke<string>('daemon_rpc', { payloadB64 }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`local rpc timeout after ${LOCAL_RPC_TIMEOUT_MS}ms`)), LOCAL_RPC_TIMEOUT_MS),
    ),
  ])
  const response = fromBinary(RpcResponseSchema, base64ToBytes(replyB64))
  if (response.requestId !== req.requestId) {
    throw new Error(`local rpc response id mismatch: ${response.requestId} !== ${req.requestId}`)
  }
  return response
}

// ---------------------------------------------------------------------------
// Core send helper
// ---------------------------------------------------------------------------

async function sendRequest(
  build: (req: RpcRequest) => void,
  targetActorId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RpcResponse> {
  if (!initialized || !teamId) {
    recordMqttDiag('teamclaw-rpc', 'request:not-initialized', { targetActorId, initialized, teamId })
    throw new Error('teamclaw-rpc not initialized')
  }
  if (!requesterActorId) {
    throw new Error('teamclaw-rpc: requesterActorId required')
  }
  if (!targetActorId) {
    throw new Error('teamclaw-rpc: targetActorId required')
  }
  const requestId = crypto.randomUUID()
  const requesterClientId = `teamclaw-${requesterActorId.slice(0, 8)}-${requestId.slice(0, 8)}`

  const req = create(RpcRequestSchema, {
    requestId,
    requesterClientId,
    requesterActorId,
  })
  build(req) // caller fills the method oneof
  recordMqttDiag('teamclaw-rpc', 'request:built', {
    requestId,
    targetActorId,
    requesterActorId,
    requesterClientId,
    method: req.method.case,
    timeoutMs,
    teamId,
  })

  // Local daemon fast path: loopback HTTP first, MQTT on any failure.
  if (shouldTryLocalRpc(targetActorId)) {
    try {
      const response = await sendViaLocalHttp(req)
      recordMqttDiag('teamclaw-rpc', 'request:local-http-ok', {
        requestId,
        targetActorId,
        method: req.method.case,
        success: response.success,
      })
      return response
    } catch (err) {
      noteLocalRpcFailure()
      recordMqttDiag('teamclaw-rpc', 'request:local-http-fallback', {
        requestId,
        targetActorId,
        method: req.method.case,
        cooldownMs: LOCAL_RPC_FAILURE_COOLDOWN_MS,
        error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      })
      // Fall through to the MQTT path below.
    }
  }

  return new Promise<RpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      recordMqttDiag('teamclaw-rpc', 'request:timeout', {
        requestId,
        targetActorId,
        method: req.method.case,
        timeoutMs,
        pending: pending.size,
      })
      reject(new Error(`rpc timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    pending.set(requestId, { resolve, reject, timer })

    const topic = `amux/${teamId!}/${targetActorId}/rpc/req`
    recordMqttDiag('teamclaw-rpc', 'request:publish-before', {
      requestId,
      topic,
      method: req.method.case,
      bytes: toBinary(RpcRequestSchema, req).byteLength,
    })
    mqttPublish(topic, toBinary(RpcRequestSchema, req), false).catch((err) => {
      clearTimeout(timer)
      pending.delete(requestId)
      recordMqttDiag('teamclaw-rpc', 'request:publish-error', {
        requestId,
        topic,
        method: req.method.case,
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      })
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

function fetchWorkspacesResponseError(response: RpcResponse): Error | null {
  if (!response.success) {
    return new Error(response.error || 'fetchWorkspaces rejected')
  }
  if (response.result.case !== 'fetchWorkspacesResult') {
    return new Error(`unexpected result variant: ${response.result.case}`)
  }
  return null
}

// ---------------------------------------------------------------------------
// Public helper: fetchWorkspaces
// ---------------------------------------------------------------------------

export interface FetchWorkspacesArgs {
  targetActorId: string
  timeoutMs?: number
}

export async function fetchWorkspaces(args: FetchWorkspacesArgs): Promise<FetchWorkspacesResult> {
  const response = await sendRequest((req) => {
    req.method = {
      case: 'fetchWorkspaces',
      value: create(FetchWorkspacesRequestSchema, {}),
    }
  }, args.targetActorId, args.timeoutMs)

  const error = fetchWorkspacesResponseError(response)
  if (error) throw error
  return response.result.value as FetchWorkspacesResult
}

// ---------------------------------------------------------------------------
// Public helper: runtimeStart
// ---------------------------------------------------------------------------

export interface RuntimeStartArgs {
  targetActorId: string    // daemon actor_id to route the RPC to
  workspaceId: string       // supabase workspace id (or empty for bare spawn)
  worktree: string          // leave empty — target daemon resolves local path from workspaceId
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
  }, args.targetActorId, args.timeoutMs)

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
  targetActorId: string
  runtimeId: string
  timeoutMs?: number
}

export async function runtimeStop(args: RuntimeStopArgs): Promise<RuntimeStopResult> {
  const response = await sendRequest((req) => {
    const stop = create(RuntimeStopRequestSchema, { runtimeId: args.runtimeId })
    req.method = { case: 'runtimeStop', value: stop }
  }, args.targetActorId, args.timeoutMs)

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
  targetActorId: string
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
  }, args.targetActorId, args.timeoutMs)

  if (!response.success) {
    throw new Error(response.error || 'setModel rejected')
  }
  if (response.result.case !== 'setModelResult') {
    throw new Error(`unexpected result variant: ${response.result.case}`)
  }
  const result = response.result.value
  if (!result.success) {
    throw new Error(result.error || 'setModel failed')
  }
  return result
}
