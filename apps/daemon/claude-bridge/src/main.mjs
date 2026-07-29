#!/usr/bin/env node
/**
 * JSONL RPC bridge between amuxd (Rust) and @anthropic-ai/claude-agent-sdk.
 *
 * Same wire protocol as cursor-bridge, so the Rust client/process/event layers
 * are shared shapes:
 *   Request:  { "id": "...", "method": "...", "params": { ... } }
 *   Response: { "id": "...", "result": { ... } }
 *   Error:    { "id": "...", "error": "..." }
 *   Event:    { "event": "...", "sessionId": "...", ... }
 *
 * The Agent SDK runs in *streaming input* mode: each session owns an async
 * iterable of user messages that we push into, which is what makes
 * `interrupt()` / `setModel()` / `setPermissionMode()` available at all — they
 * are control-protocol calls and only exist on a streaming query.
 */
import readline from 'node:readline'
import { query, AbortError } from '@anthropic-ai/claude-agent-sdk'

/**
 * @typedef {{
 *   q: import('@anthropic-ai/claude-agent-sdk').Query,
 *   input: PushQueue,
 *   cwd: string,
 *   sessionId: string,
 *   model: string,
 *   turnActive: boolean,
 * }} Session
 */

/** @type {Map<string, Session>} */
const sessions = new Map()

/** requestId → resolve fn for a pending canUseTool callback. */
const pendingPermissions = new Map()

let nextPermissionId = 1

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

/**
 * Push-driven async iterable. The SDK pulls user messages from this; `push`
 * hands one over (waking a blocked pull), `close` ends the session's input.
 */
class PushQueue {
  constructor() {
    this.items = []
    this.waiting = []
    this.done = false
  }

  push(item) {
    const waiter = this.waiting.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  close() {
    this.done = true
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift(), done: false })
        if (this.done) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiting.push(resolve))
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

function userMessage(text, sessionId) {
  return {
    type: 'user',
    session_id: sessionId ?? '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function paramsToObject(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { input: JSON.stringify(input ?? null) }
  }
  const out = {}
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return out
}

function toolResultText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(b)))
      .join('\n')
  }
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/**
 * The permission gate. Blocks until amuxd answers, so the daemon — not this
 * process — decides how long a human may take. `full_access` sessions never
 * reach here: they run with permissionMode `bypassPermissions`.
 */
function makeCanUseTool(sessionKey) {
  return (toolName, input, { signal, suggestions, toolUseID }) =>
    new Promise((resolve) => {
      const requestId = `perm-${nextPermissionId++}`
      const settle = (result) => {
        if (!pendingPermissions.delete(requestId)) return
        resolve(result)
      }
      pendingPermissions.set(requestId, { settle, input })

      // An aborted turn must not leave the SDK waiting on us forever.
      signal?.addEventListener?.('abort', () =>
        settle({ behavior: 'deny', message: 'Turn was cancelled.', interrupt: true }),
      )

      emit({
        event: 'permission_request',
        sessionId: sessionKey,
        requestId,
        toolName,
        toolUseId: toolUseID,
        input: paramsToObject(input),
        // Non-empty means the SDK can persist an "always allow" for this tool.
        canAlways: Array.isArray(suggestions) && suggestions.length > 0,
        suggestions: suggestions ?? [],
      })
    })
}

function handleAssistantMessage(sessionKey, message) {
  for (const block of message.message?.content ?? []) {
    if (block.type === 'text' && block.text) {
      emit({ event: 'assistant_delta', sessionId: sessionKey, text: block.text })
    } else if (block.type === 'thinking' && block.thinking) {
      emit({ event: 'thinking_delta', sessionId: sessionKey, text: block.thinking })
    } else if (block.type === 'tool_use') {
      emit({
        event: 'tool_start',
        sessionId: sessionKey,
        toolCallId: block.id,
        toolName: block.name,
        args: paramsToObject(block.input),
      })
    }
  }
}

/** Tool results arrive as `user` messages carrying tool_result blocks. */
function handleUserMessage(sessionKey, message) {
  const content = message.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block.type !== 'tool_result') continue
    emit({
      event: 'tool_end',
      sessionId: sessionKey,
      toolCallId: block.tool_use_id,
      summary: toolResultText(block.content),
      isError: block.is_error === true,
    })
  }
}

async function pumpSession(sessionKey, session) {
  try {
    for await (const message of session.q) {
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') {
            session.sessionId = message.session_id
            session.model = message.model ?? session.model
          }
          break
        case 'assistant':
          handleAssistantMessage(sessionKey, message)
          break
        case 'user':
          handleUserMessage(sessionKey, message)
          break
        case 'result': {
          if (message.subtype !== 'success') {
            emit({
              event: 'run_error',
              sessionId: sessionKey,
              message: (message.errors ?? []).join('; ') || message.subtype,
            })
          }
          // modelUsage is keyed by the model that actually ran the turn — the
          // authoritative reading, unlike whatever we last asked for.
          const used = Object.keys(message.modelUsage ?? {})
          if (used.length > 0) session.model = used[used.length - 1]
          session.turnActive = false
          emit({
            event: 'turn_end',
            sessionId: sessionKey,
            status: message.subtype,
            model: session.model,
            costUsd: message.total_cost_usd,
          })
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    if (!(err instanceof AbortError)) {
      emit({ event: 'run_error', sessionId: sessionKey, message: String(err?.message ?? err) })
    }
    session.turnActive = false
    emit({ event: 'turn_end', sessionId: sessionKey, status: 'error' })
  } finally {
    // Nothing more will arrive for this session; release anything still blocked.
    for (const [requestId, pending] of [...pendingPermissions]) {
      pending.settle({ behavior: 'deny', message: 'Session ended.', interrupt: true })
      pendingPermissions.delete(requestId)
    }
  }
}

function mcpServersOption(mcpServers) {
  if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) return {}
  return Object.keys(mcpServers).length > 0 ? { mcpServers } : {}
}

async function startSession(params, resume) {
  const cwd = params.cwd
  if (!cwd) throw new Error('cwd is required')
  const sessionKey = `pending-${nextPermissionId++}`
  const input = new PushQueue()

  const fullAccess = params.permissionMode === 'bypassPermissions'
  const q = query({
    prompt: input,
    options: {
      cwd,
      ...(params.model ? { model: params.model } : {}),
      ...(resume ? { resume } : {}),
      ...mcpServersOption(params.mcpServers),
      permissionMode: params.permissionMode ?? 'default',
      // bypassPermissions never consults canUseTool; wiring it anyway would be
      // dead code that hides which mode is actually in force.
      ...(fullAccess ? {} : { canUseTool: makeCanUseTool(sessionKey) }),
    },
  })

  const session = {
    q,
    input,
    cwd,
    sessionId: resume ?? '',
    model: params.model ?? '',
    turnActive: false,
  }
  sessions.set(sessionKey, session)
  void pumpSession(sessionKey, session)

  // The SDK emits system/init only once it has spun up; the session id it
  // carries is what we persist for resume. Nudge it with an empty turn only if
  // the caller gave no initial prompt — otherwise the prompt itself starts it.
  input.push(userMessage(params.initialPrompt || 'Ready.', session.sessionId))
  session.turnActive = true
  emit({ event: 'turn_start', sessionId: sessionKey })

  const deadline = Date.now() + 60_000
  while (!session.sessionId && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  if (!session.sessionId) throw new Error('claude session did not initialize within 60s')
  return { sessionKey, session }
}

async function handleRequest(req) {
  const { id, method, params = {} } = req
  try {
    switch (method) {
      case 'list_models': {
        const existing = [...sessions.values()][0]
        if (!existing) {
          emit({ id, result: { models: [] } })
          break
        }
        const models = await existing.q.supportedModels()
        emit({
          id,
          result: {
            models: models.map((m) => ({
              id: `claude/${m.value}`,
              displayName: m.displayName ?? m.value,
              providerName: 'claude',
              description: m.description ?? '',
            })),
          },
        })
        break
      }
      case 'create_session':
      case 'resume_session': {
        const resume = method === 'resume_session' ? params.sessionId : undefined
        if (method === 'resume_session' && !resume) throw new Error('sessionId is required')
        const { sessionKey, session } = await startSession(params, resume)
        emit({ id, result: { sessionKey, sessionId: session.sessionId, model: session.model } })
        break
      }
      case 'send': {
        const session = sessions.get(params.sessionKey)
        if (!session) throw new Error(`unknown session ${params.sessionKey}`)
        if (!params.text) throw new Error('text is required')
        if (params.model && params.model !== session.model) {
          await session.q.setModel(params.model)
          session.model = params.model
        }
        session.turnActive = true
        emit({ event: 'turn_start', sessionId: params.sessionKey })
        session.input.push(userMessage(params.text, session.sessionId))
        emit({ id, result: { ok: true } })
        break
      }
      case 'cancel': {
        const session = sessions.get(params.sessionKey)
        if (session) await session.q.interrupt()
        emit({ id, result: { ok: true } })
        break
      }
      case 'set_model': {
        const session = sessions.get(params.sessionKey)
        if (!session) throw new Error(`unknown session ${params.sessionKey}`)
        // A real control-protocol call — takes effect on the next turn.
        await session.q.setModel(params.model || undefined)
        session.model = params.model ?? ''
        emit({ id, result: { model: session.model } })
        break
      }
      case 'get_session_info': {
        const session = sessions.get(params.sessionKey)
        if (!session) throw new Error(`unknown session ${params.sessionKey}`)
        emit({
          id,
          result: {
            sessionId: session.sessionId,
            cwd: session.cwd,
            // Reported by the SDK (init / result.modelUsage), not our request.
            ...(session.model ? { sdkModel: `claude/${session.model}` } : {}),
          },
        })
        break
      }
      case 'resolve_permission': {
        const pending = pendingPermissions.get(params.requestId)
        if (!pending) {
          emit({ id, result: { ok: false, reason: 'unknown request' } })
          break
        }
        if (params.granted) {
          pending.settle({
            behavior: 'allow',
            updatedInput: pending.input,
            // "Always allow" rides the SDK's own suggestions so the rule it
            // persists matches what the tool call actually needs.
            ...(params.always && Array.isArray(params.suggestions) && params.suggestions.length > 0
              ? { updatedPermissions: params.suggestions }
              : {}),
          })
        } else {
          pending.settle({
            behavior: 'deny',
            message: params.message || 'The user rejected this tool call.',
            interrupt: params.interrupt === true,
          })
        }
        emit({ id, result: { ok: true } })
        break
      }
      case 'close_session': {
        const session = sessions.get(params.sessionKey)
        if (session) {
          session.input.close()
          sessions.delete(params.sessionKey)
        }
        emit({ id, result: { ok: true } })
        break
      }
      default:
        emit({ id, error: `unknown method: ${method}` })
    }
  } catch (err) {
    emit({ id, error: String(err?.message ?? err) })
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
    if (req?.method && req?.id != null) void handleRequest(req)
  }
  for (const session of sessions.values()) session.input.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
