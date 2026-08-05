#!/usr/bin/env node
/**
 * JSONL RPC bridge between amuxd (Rust) and @cursor/sdk.
 *
 * Protocol:
 *   Request:  { "id": "...", "method": "...", "params": { ... } }
 *   Response: { "id": "...", "result": { ... } }
 *   Error:    { "id": "...", "error": "..." }
 *   Event:    { "event": "...", "agentId": "...", "runId": "...", ... }
 */
import readline from 'node:readline'
import { Agent, Cursor, CursorAgentError } from '@cursor/sdk'

import { errorMessage, isStaleAuthError, isStaleAuthErrorMessage } from './auth-retry.mjs'

/** @type {Map<string, { agent: import('@cursor/sdk').Agent, cwd: string, model: string, mcpServers?: Record<string, unknown> | null }>} */
const agents = new Map()

/** @type {Map<string, { agentId: string, run: import('@cursor/sdk').Run | null, cancelled: boolean }>} */
const activeRuns = new Map()

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function logStaleAuth(phase, agentId) {
  console.error(`[cursor-bridge] stale auth during ${phase} for ${agentId}; refreshing agent connection`)
}

function flatModelId(sdkId) {
  return `cursor/${sdkId}`
}

function sdkModelFromFlat(flat) {
  if (!flat || typeof flat !== 'string') return 'composer-2.5'
  const slash = flat.indexOf('/')
  if (slash === -1) return flat
  const provider = flat.slice(0, slash)
  const model = flat.slice(slash + 1)
  if (provider === 'cursor' && model) return model
  return model || 'composer-2.5'
}

/**
 * AgentOptions.mcpServers is a Record<string, McpServerConfig> — not an array.
 * Drop the field entirely when there is nothing to bridge.
 */
function mcpServersOption(mcpServers) {
  if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) return {}
  return Object.keys(mcpServers).length > 0 ? { mcpServers } : {}
}

function apiKeyFromEnv() {
  const key = process.env.CURSOR_API_KEY?.trim()
  if (!key) throw new Error('CURSOR_API_KEY is not set')
  return key
}

async function disposeAgent(agentId) {
  const entry = agents.get(agentId)
  if (!entry) return
  agents.delete(agentId)
  try {
    await entry.agent[Symbol.asyncDispose]?.()
  } catch {
    // best-effort
  }
}

/**
 * Drop a stale SDK handle and resume with a fresh gRPC connection + token.
 * Cursor SDK issue: idle agents return AuthenticationError until resumed.
 */
async function refreshAgentConnection(agentId) {
  const entry = agents.get(agentId)
  if (!entry) throw new Error(`unknown agent ${agentId}`)
  const { cwd, model, mcpServers } = entry
  await disposeAgent(agentId)
  const agent = await Agent.resume(agentId, {
    apiKey: apiKeyFromEnv(),
    ...mcpServersOption(mcpServers),
  })
  const refreshed = { agent, cwd, model, mcpServers }
  agents.set(agent.agentId, refreshed)
  return refreshed
}

async function agentSend(entry, text) {
  return entry.agent.send(text, { model: { id: entry.model } })
}

async function sendWithAuthRetry(agentId, text, modelOverride) {
  let entry = agents.get(agentId)
  if (!entry) throw new Error(`unknown agent ${agentId}`)
  if (modelOverride) entry.model = sdkModelFromFlat(modelOverride)
  try {
    const run = await agentSend(entry, text)
    return { entry, run }
  } catch (err) {
    if (!isStaleAuthError(err)) throw err
    logStaleAuth('send', agentId)
    entry = await refreshAgentConnection(agentId)
    const run = await agentSend(entry, text)
    return { entry, run }
  }
}

function paramsToObject(input) {
  if (input == null) return {}
  if (typeof input === 'object' && !Array.isArray(input)) {
    const out = {}
    for (const [k, v] of Object.entries(input)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v)
    }
    return out
  }
  return { input: JSON.stringify(input) }
}

function toolResultText(result) {
  if (result == null) return ''
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function handleStreamEvent(agentId, runId, message, streamCtx) {
  switch (message.type) {
    case 'assistant': {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          emit({ event: 'assistant_delta', agentId, runId, text: block.text })
        }
        if (block.type === 'tool_use') {
          emit({
            event: 'tool_start',
            agentId,
            runId,
            toolCallId: block.id,
            toolName: block.name,
            args: paramsToObject(block.input),
          })
        }
      }
      break
    }
    case 'thinking':
      if (message.text) {
        emit({ event: 'thinking_delta', agentId, runId, text: message.text })
      }
      break
    case 'tool_call': {
      if (message.status === 'running') {
        emit({
          event: 'tool_start',
          agentId,
          runId,
          toolCallId: message.call_id,
          toolName: message.name,
          args: paramsToObject(message.args),
        })
      } else {
        emit({
          event: 'tool_end',
          agentId,
          runId,
          toolCallId: message.call_id,
          summary: toolResultText(message.result),
          isError: message.status === 'error',
        })
      }
      break
    }
    case 'status':
      if (message.status === 'ERROR') {
        const msg = message.message ?? 'cursor run error'
        if (streamCtx?.deferAuthError && isStaleAuthErrorMessage(msg)) {
          streamCtx.deferredAuthError = msg
          break
        }
        emit({
          event: 'run_error',
          agentId,
          runId,
          message: msg,
        })
      }
      break
    default:
      break
  }
}

async function retryStreamAfterAuthRefresh(agentId, text) {
  logStaleAuth('stream', agentId)
  await refreshAgentConnection(agentId)
  const entry = agents.get(agentId)
  if (!entry) throw new Error(`unknown agent ${agentId}`)
  const run = await agentSend(entry, text)
  return streamRun(agentId, run, text, true)
}

async function streamRun(agentId, run, text, authRetried = false) {
  activeRuns.set(agentId, { agentId, run, cancelled: false })
  emit({ event: 'turn_start', agentId, runId: run.id })

  const canRetryAuth = Boolean(text) && !authRetried
  const streamCtx = canRetryAuth ? { deferAuthError: true, deferredAuthError: null } : null

  try {
    for await (const event of run.stream()) {
      const state = activeRuns.get(agentId)
      if (state?.cancelled) break
      handleStreamEvent(agentId, run.id, event, streamCtx ?? undefined)
    }

    const state = activeRuns.get(agentId)
    if (!state?.cancelled) {
      if (streamCtx?.deferredAuthError && canRetryAuth) {
        activeRuns.delete(agentId)
        await retryStreamAfterAuthRefresh(agentId, text)
        return
      }

      const result = await run.wait()
      emit({
        event: 'turn_end',
        agentId,
        runId: run.id,
        status: result.status,
        model: result.model?.id ? flatModelId(result.model.id) : undefined,
      })
    }
  } catch (err) {
    if (isStaleAuthError(err) && canRetryAuth) {
      activeRuns.delete(agentId)
      try {
        await retryStreamAfterAuthRefresh(agentId, text)
        return
      } catch (retryErr) {
        err = retryErr
      }
    }
    const msg = err instanceof CursorAgentError ? err.message : errorMessage(err)
    emit({ event: 'run_error', agentId, runId: run.id, message: msg })
    emit({ event: 'turn_end', agentId, runId: run.id, status: 'error' })
  } finally {
    activeRuns.delete(agentId)
  }
}

async function handleRequest(req) {
  const { id, method, params = {} } = req
  try {
    switch (method) {
      case 'list_models': {
        const models = await Cursor.models.list({ apiKey: apiKeyFromEnv() })
        emit({
          id,
          result: {
            models: models.map((m) => ({
              id: flatModelId(m.id),
              displayName: m.name ?? m.id,
              providerName: 'cursor',
              sdkId: m.id,
            })),
          },
        })
        break
      }
      case 'create_agent': {
        const cwd = params.cwd
        if (!cwd) throw new Error('cwd is required')
        const model = sdkModelFromFlat(params.model)
        const agent = await Agent.create({
          apiKey: apiKeyFromEnv(),
          model: { id: model },
          // "project" is what makes the SDK read <cwd>/.cursor/hooks.json —
          // amuxd's preToolUse permission gate lives there. It also enables the
          // workspace's own rules/AGENTS.md, matching opencode and pi.
          local: { cwd, settingSources: ['project'] },
          ...mcpServersOption(params.mcpServers),
        })
        agents.set(agent.agentId, {
          agent,
          cwd,
          model,
          mcpServers: params.mcpServers ?? null,
        })
        emit({
          id,
          result: {
            agentId: agent.agentId,
            model: flatModelId(model),
          },
        })
        break
      }
      case 'resume_agent': {
        const agentId = params.agentId
        if (!agentId) throw new Error('agentId is required')
        const agent = await Agent.resume(agentId, {
          apiKey: apiKeyFromEnv(),
          // Inline MCP is not persisted by the SDK: resume must re-send it.
          ...mcpServersOption(params.mcpServers),
        })
        const model = sdkModelFromFlat(params.model) || 'composer-2.5'
        agents.set(agent.agentId, {
          agent,
          cwd: params.cwd ?? process.cwd(),
          model,
          mcpServers: params.mcpServers ?? null,
        })
        emit({
          id,
          result: {
            agentId: agent.agentId,
            model: flatModelId(model),
          },
        })
        break
      }
      case 'send': {
        const agentId = params.agentId
        const text = params.text
        if (!agentId || !text) throw new Error('agentId and text are required')
        const { entry, run } = await sendWithAuthRetry(agentId, text, params.model)
        emit({ id, result: { runId: run.id, model: flatModelId(entry.model) } })
        void streamRun(agentId, run, text)
        break
      }
      case 'cancel': {
        const agentId = params.agentId
        const state = activeRuns.get(agentId)
        if (state?.run?.supports?.('cancel')) {
          await state.run.cancel()
        }
        if (state) state.cancelled = true
        emit({ id, result: { ok: true } })
        break
      }
      case 'set_model': {
        // Takes effect on the next send (the SDK has no standalone model
        // setter); same "applies next turn" semantics as the opencode backend.
        const agentId = params.agentId
        const model = sdkModelFromFlat(params.model)
        const entry = agents.get(agentId)
        if (!entry) throw new Error(`unknown agent ${agentId}`)
        entry.model = model
        emit({ id, result: { model: flatModelId(model) } })
        break
      }
      case 'get_agent_info': {
        const agentId = params.agentId
        const entry = agents.get(agentId)
        if (!entry) throw new Error(`unknown agent ${agentId}`)
        // `agent.model` is the SDK's own current selection, updated after each
        // successful send. `requestedModel` is merely what we last asked for —
        // the two are reported separately so the daemon's MRU only ever learns
        // from the former.
        const sdkModel = entry.agent.model?.id
        emit({
          id,
          result: {
            agentId,
            cwd: entry.cwd,
            requestedModel: flatModelId(entry.model),
            ...(sdkModel ? { sdkModel: flatModelId(sdkModel) } : {}),
          },
        })
        break
      }
      case 'dispose_agent': {
        await disposeAgent(params.agentId)
        emit({ id, result: { ok: true } })
        break
      }
      default:
        emit({ id, error: `unknown method: ${method}` })
    }
  } catch (err) {
    const msg = err instanceof CursorAgentError ? err.message : errorMessage(err)
    emit({ id, error: msg })
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let req
    try {
      req = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (req?.method && req?.id != null) {
      void handleRequest(req)
    }
  }
  for (const agentId of [...agents.keys()]) {
    await disposeAgent(agentId)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
