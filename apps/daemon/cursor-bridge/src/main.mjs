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

/** @type {Map<string, { agent: import('@cursor/sdk').Agent, cwd: string, model: string }>} */
const agents = new Map()

/** @type {Map<string, { agentId: string, run: import('@cursor/sdk').Run | null, cancelled: boolean }>} */
const activeRuns = new Map()

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
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

function handleStreamEvent(agentId, runId, message) {
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
        emit({
          event: 'run_error',
          agentId,
          runId,
          message: message.message ?? 'cursor run error',
        })
      }
      break
    case 'request':
      emit({
        event: 'permission_request',
        agentId,
        runId,
        requestId: message.request_id,
      })
      break
    default:
      break
  }
}

async function streamRun(agentId, run) {
  activeRuns.set(agentId, { agentId, run, cancelled: false })
  emit({ event: 'turn_start', agentId, runId: run.id })

  try {
    for await (const event of run.stream()) {
      const state = activeRuns.get(agentId)
      if (state?.cancelled) break
      // run.stream() yields SDKMessage directly (assistant, thinking, tool_call, …).
      handleStreamEvent(agentId, run.id, event)
    }

    const state = activeRuns.get(agentId)
    if (!state?.cancelled) {
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
    const msg = err instanceof CursorAgentError ? err.message : String(err)
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
          local: { cwd, settingSources: [] },
          ...(params.mcpServers?.length ? { mcpServers: params.mcpServers } : {}),
        })
        agents.set(agent.agentId, { agent, cwd, model })
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
          ...(params.mcpServers?.length ? { mcpServers: params.mcpServers } : {}),
        })
        const model = sdkModelFromFlat(params.model) || 'composer-2.5'
        agents.set(agent.agentId, { agent, cwd: params.cwd ?? process.cwd(), model })
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
        const entry = agents.get(agentId)
        if (!entry) throw new Error(`unknown agent ${agentId}`)
        const run = await entry.agent.send(text)
        emit({ id, result: { runId: run.id } })
        void streamRun(agentId, run)
        break
      }
      case 'cancel': {
        const agentId = params.agentId
        const entry = agents.get(agentId)
        const state = activeRuns.get(agentId)
        if (state?.run?.supports?.('cancel')) {
          await state.run.cancel()
        }
        if (state) state.cancelled = true
        emit({ id, result: { ok: true } })
        break
      }
      case 'set_model': {
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
        emit({
          id,
          result: { agentId, model: flatModelId(entry.model), cwd: entry.cwd },
        })
        break
      }
      case 'resolve_permission': {
        emit({ id, result: { ok: true } })
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
    const msg = err instanceof CursorAgentError ? err.message : String(err)
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
