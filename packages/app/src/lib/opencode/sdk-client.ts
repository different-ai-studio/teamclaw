/**
 * sdk-client.ts — Singleton wrapper around @opencode-ai/sdk OpencodeClient.
 *
 * Replaces the hand-rolled OpenCodeClient class in client.ts with thin
 * convenience wrappers that delegate to the SDK's generated client.
 *
 * Consumers can either:
 *   1. Call named function exports (createSession, sendMessage, ...) which
 *      internally grab the singleton and unwrap the SDK response.
 *   2. Call getOpenCodeClient() to get the raw OpencodeClient for advanced use.
 */

import {
  createOpencodeClient,
  OpencodeClient,
  type OpencodeClientConfig,
} from '@opencode-ai/sdk/v2/client'

import type {
  OpenCodeConfig,
  Command,
  MCPServerConfig,
  SendMessageRequest,
  PermissionReplyRequest,
} from './sdk-types'

// Re-export Command type for convenience (matches old client.ts)
export type { Command }

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let sdkClient: OpencodeClient | null = null
let currentConfig: OpenCodeConfig | null = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Unwrap an SDK response, throwing on error.
 * SDK methods return `{ data, error, request, response }` in "fields" mode.
 */
function unwrap<T>(result: { data: T | undefined; error: unknown }): T {
  if (result.error !== undefined) {
    const msg =
      typeof result.error === 'string'
        ? result.error
        : result.error && typeof result.error === 'object' && 'message' in result.error
          ? String((result.error as { message: string }).message)
          : JSON.stringify(result.error)
    throw new Error(`OpenCode API Error: ${msg}`)
  }
  return result.data as T
}

/**
 * Build SDK client config from our OpenCodeConfig shape.
 */
function buildSdkConfig(config: OpenCodeConfig): OpencodeClientConfig & { directory?: string } {
  const sdkConfig: OpencodeClientConfig & { directory?: string } = {
    baseUrl: config.baseUrl.replace(/\/$/, ''),
  }
  if (config.workspacePath) {
    sdkConfig.directory = config.workspacePath
  }
  return sdkConfig
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Initialize the singleton SDK client. Must be called before any other function.
 */
export function initOpenCodeClient(config: OpenCodeConfig): OpencodeClient {
  currentConfig = config
  const sdkConfig = buildSdkConfig(config)
  sdkClient = createOpencodeClient(sdkConfig)

  // If there is a password / bearer token, add an auth interceptor
  if (config.password) {
    const token = config.password
    sdkClient['client'].interceptors.request.use((req) => {
      req.headers.set('Authorization', `Bearer ${token}`)
      return req
    })
  }

  return sdkClient
}

/**
 * Return the singleton SDK client instance.
 * Throws if initOpenCodeClient() has not been called.
 */
export function getOpenCodeClient(): OpencodeClient {
  if (!sdkClient) {
    throw new Error('OpenCodeClient not initialized. Call initOpenCodeClient() first.')
  }
  return sdkClient
}

/**
 * Update the workspace / directory path used for all subsequent API calls.
 * Recreates the underlying SDK client so that the `directory` default is baked in.
 */
export function updateOpenCodeClientWorkspace(workspacePath: string | null): void {
  if (!currentConfig) return
  currentConfig = { ...currentConfig, workspacePath: workspacePath || undefined }
  // Re-init with updated config so that directory param is set globally
  initOpenCodeClient(currentConfig)
}

// ---------------------------------------------------------------------------
// Internal helper — get directory param from current config
// ---------------------------------------------------------------------------

function dir(): string | undefined {
  return currentConfig?.workspacePath || undefined
}

// ---------------------------------------------------------------------------
// Session convenience wrappers
// ---------------------------------------------------------------------------

export async function createSession(): Promise<unknown> {
  const client = getOpenCodeClient()
  const result = await client.session.create({ directory: dir() })
  return unwrap(result)
}

export async function listSessions(options?: {
  directory?: string
  roots?: boolean
}): Promise<unknown[]> {
  const client = getOpenCodeClient()
  const result = await client.session.list({
    directory: options?.directory || dir(),
    roots: options?.roots,
  })
  return unwrap(result) as unknown[]
}

export async function getSession(id: string): Promise<unknown> {
  const client = getOpenCodeClient()
  const result = await client.session.get({ sessionID: id, directory: dir() })
  return unwrap(result)
}

export async function deleteSession(id: string): Promise<void> {
  const client = getOpenCodeClient()
  const result = await client.session.delete({ sessionID: id, directory: dir() })
  unwrap(result)
}

export async function archiveSession(id: string, directory?: string): Promise<void> {
  const client = getOpenCodeClient()
  const result = await client.session.update({
    sessionID: id,
    directory: directory || dir(),
    time: { archived: Date.now() },
  })
  unwrap(result)
}

export async function updateSession(
  id: string,
  updates: { title?: string },
): Promise<unknown> {
  const client = getOpenCodeClient()
  const result = await client.session.update({
    sessionID: id,
    directory: dir(),
    ...updates,
  })
  return unwrap(result)
}

export async function abortSession(id: string): Promise<boolean> {
  const client = getOpenCodeClient()
  const result = await client.session.abort({ sessionID: id, directory: dir() })
  unwrap(result)
  return true
}

// ---------------------------------------------------------------------------
// Message convenience wrappers
// ---------------------------------------------------------------------------

export async function getMessages(sessionId: string): Promise<unknown[]> {
  const client = getOpenCodeClient()
  const result = await client.session.messages({
    sessionID: sessionId,
    directory: dir(),
  })
  return unwrap(result) as unknown[]
}

export async function sendMessage(
  sessionId: string,
  content: string,
  model?: { providerID: string; modelID: string },
  agent?: string,
  systemPrompt?: string,
): Promise<unknown> {
  const client = getOpenCodeClient()
  const trimmedSystem = systemPrompt?.trim()

  if (trimmedSystem) {
    console.log('[OpenCode] Sending message with system prompt:', {
      sessionId,
      systemPromptLength: trimmedSystem.length,
      systemPromptPreview:
        trimmedSystem.substring(0, 100) +
        (trimmedSystem.length > 100 ? '...' : ''),
    })
  }

  const result = await client.session.prompt({
    sessionID: sessionId,
    directory: dir(),
    parts: [{ type: 'text', text: content }],
    ...(model && { model }),
    ...(agent && { agent }),
    ...(trimmedSystem && { system: trimmedSystem }),
  })
  return unwrap(result)
}

export async function sendMessageWithParts(
  sessionId: string,
  parts: SendMessageRequest['parts'],
  model?: { providerID: string; modelID: string },
  systemPrompt?: string,
): Promise<unknown> {
  const client = getOpenCodeClient()
  const result = await client.session.prompt({
    sessionID: sessionId,
    directory: dir(),
    parts: parts as Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string }>,
    ...(model && { model }),
    ...(systemPrompt?.trim() && { system: systemPrompt.trim() }),
  })
  return unwrap(result)
}

export async function sendMessageAsync(
  sessionId: string,
  content: string,
  model?: { providerID: string; modelID: string },
  agent?: string,
  systemPrompt?: string,
): Promise<void> {
  const client = getOpenCodeClient()
  const result = await client.session.promptAsync({
    sessionID: sessionId,
    directory: dir(),
    parts: [{ type: 'text', text: content }],
    ...(model && { model }),
    ...(agent && { agent }),
    ...(systemPrompt?.trim() && { system: systemPrompt.trim() }),
  })
  unwrap(result)
}

export async function sendMessageWithPartsAsync(
  sessionId: string,
  parts: SendMessageRequest['parts'],
  model?: { providerID: string; modelID: string },
  agent?: string,
  systemPrompt?: string,
): Promise<void> {
  const client = getOpenCodeClient()
  const result = await client.session.promptAsync({
    sessionID: sessionId,
    directory: dir(),
    parts: parts as Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string }>,
    ...(model && { model }),
    ...(agent && { agent }),
    ...(systemPrompt?.trim() && { system: systemPrompt.trim() }),
  })
  unwrap(result)
}

// ---------------------------------------------------------------------------
// Question convenience wrappers
// ---------------------------------------------------------------------------

export async function replyQuestion(
  requestID: string,
  answers: string[][],
): Promise<boolean> {
  const client = getOpenCodeClient()
  const result = await client.question.reply({
    requestID,
    directory: dir(),
    answers,
  })
  unwrap(result)
  return true
}

export async function rejectQuestion(requestID: string): Promise<boolean> {
  const client = getOpenCodeClient()
  const result = await client.question.reject({
    requestID,
    directory: dir(),
  })
  unwrap(result)
  return true
}

export async function listQuestions(): Promise<unknown[]> {
  const client = getOpenCodeClient()
  const result = await client.question.list({ directory: dir() })
  return unwrap(result) as unknown[]
}

// ---------------------------------------------------------------------------
// Todo / Diff / File status
// ---------------------------------------------------------------------------

export async function getTodos(
  sessionId: string,
): Promise<
  Array<{ id: string; content: string; status: string; priority: string }>
> {
  const client = getOpenCodeClient()
  const result = await client.session.todo({
    sessionID: sessionId,
    directory: dir(),
  })
  return unwrap(result) as Array<{
    id: string
    content: string
    status: string
    priority: string
  }>
}

export async function getSessionDiff(
  sessionId: string,
): Promise<
  Array<{
    file: string
    before: string
    after: string
    additions: number
    deletions: number
  }>
> {
  const client = getOpenCodeClient()
  const result = await client.session.diff({
    sessionID: sessionId,
    directory: dir(),
  })
  // SDK returns SnapshotFileDiff[] with { file, patch, additions, deletions }
  // We map to the old shape with before/after (patch goes into after, before is empty)
  const diffs = unwrap(result) as unknown as Array<{
    file: string
    patch: string
    additions: number
    deletions: number
  }>
  return diffs.map((d) => ({
    file: d.file,
    before: '',
    after: d.patch || '',
    additions: d.additions,
    deletions: d.deletions,
  }))
}

export async function getFileStatus(): Promise<
  Array<{
    path: string
    added: number
    removed: number
    status: 'added' | 'deleted' | 'modified'
  }>
> {
  const client = getOpenCodeClient()
  const result = await client.file.status({ directory: dir() })
  return unwrap(result) as Array<{
    path: string
    added: number
    removed: number
    status: 'added' | 'deleted' | 'modified'
  }>
}

// ---------------------------------------------------------------------------
// Permission convenience wrappers
// ---------------------------------------------------------------------------

export async function listPermissions(): Promise<unknown[]> {
  const client = getOpenCodeClient()
  const result = await client.permission.list({ directory: dir() })
  return unwrap(result) as unknown[]
}

export async function replyPermission(
  permissionId: string,
  request: PermissionReplyRequest,
): Promise<void> {
  const client = getOpenCodeClient()
  const result = await client.permission.reply({
    requestID: permissionId,
    directory: dir(),
    reply: request.reply,
  })
  unwrap(result)
}

// ---------------------------------------------------------------------------
// Provider convenience wrappers
// ---------------------------------------------------------------------------

export async function getProviders(): Promise<{
  all: Array<{
    id: string
    name: string
    models: Record<string, { id: string; name: string }>
  }>
  connected: string[]
  default: Record<string, string>
}> {
  const client = getOpenCodeClient()
  const result = await client.provider.list({ directory: dir() })
  return unwrap(result) as {
    all: Array<{
      id: string
      name: string
      models: Record<string, { id: string; name: string }>
    }>
    connected: string[]
    default: Record<string, string>
  }
}

export async function getConfigProviders(): Promise<{
  providers: Array<{
    id: string
    name: string
    models: Record<string, { id: string; name: string }>
  }>
  default: Record<string, string>
}> {
  const client = getOpenCodeClient()
  const result = await client.config.providers({ directory: dir() })
  return unwrap(result) as {
    providers: Array<{
      id: string
      name: string
      models: Record<string, { id: string; name: string }>
    }>
    default: Record<string, string>
  }
}

// ---------------------------------------------------------------------------
// Config convenience wrappers
// ---------------------------------------------------------------------------

export async function getConfig(): Promise<{ model?: string }> {
  const client = getOpenCodeClient()
  const result = await client.config.get({ directory: dir() })
  return unwrap(result) as { model?: string }
}

export async function updateConfig(
  config: { model?: string },
): Promise<{ model?: string }> {
  const client = getOpenCodeClient()
  const result = await client.config.update({
    directory: dir(),
    config,
  })
  return unwrap(result) as { model?: string }
}

// ---------------------------------------------------------------------------
// Auth convenience wrappers
// ---------------------------------------------------------------------------

export async function setAuth(
  providerId: string,
  auth:
    | { type: 'api'; key: string }
    | { type: 'oauth'; refresh: string; access: string; expires: number },
): Promise<boolean> {
  const client = getOpenCodeClient()
  const result = await client.auth.set({
    providerID: providerId,
    auth: auth as { type: 'api'; key: string },
  })
  unwrap(result)
  return true
}

export async function deleteAuth(providerId: string): Promise<boolean> {
  const client = getOpenCodeClient()
  const result = await client.auth.remove({ providerID: providerId })
  unwrap(result)
  return true
}

export async function getAuthMethods(): Promise<
  Record<
    string,
    Array<{ type: 'oauth' | 'api'; label: string; prompts?: unknown[] }>
  >
> {
  const client = getOpenCodeClient()
  const result = await client.provider.auth({ directory: dir() })
  return unwrap(result) as Record<
    string,
    Array<{ type: 'oauth' | 'api'; label: string; prompts?: unknown[] }>
  >
}

export async function oauthAuthorize(
  providerId: string,
  method: number,
  inputs?: Record<string, string>,
): Promise<
  | { url: string; method: 'auto' | 'code'; instructions: string }
  | undefined
> {
  const client = getOpenCodeClient()
  const result = await client.provider.oauth.authorize({
    providerID: providerId,
    directory: dir(),
    method,
    inputs,
  })
  return unwrap(result) as
    | { url: string; method: 'auto' | 'code'; instructions: string }
    | undefined
}

export async function oauthCallback(
  providerId: string,
  method: number,
  code?: string,
): Promise<boolean> {
  const client = getOpenCodeClient()
  const result = await client.provider.oauth.callback({
    providerID: providerId,
    directory: dir(),
    method,
    ...(code ? { code } : {}),
  })
  unwrap(result)
  return true
}

// ---------------------------------------------------------------------------
// Project convenience wrappers
// ---------------------------------------------------------------------------

export async function getProject(): Promise<unknown> {
  const client = getOpenCodeClient()
  const result = await client.project.current({ directory: dir() })
  return unwrap(result)
}

// ---------------------------------------------------------------------------
// File convenience wrappers
// ---------------------------------------------------------------------------

export async function readFile(path: string): Promise<string> {
  const client = getOpenCodeClient()
  const result = await client.file.read({ directory: dir(), path })
  // SDK returns FileContent { type, content, ... } — extract the text content
  const fileContent = unwrap(result) as unknown as { type: string; content: string }
  return fileContent.content
}

export async function listDirectory(path: string): Promise<string[]> {
  const client = getOpenCodeClient()
  const result = await client.file.list({ directory: dir(), path })
  // SDK returns FileNode[] { name, path, absolute, type, ignored }
  const nodes = unwrap(result) as unknown as Array<{ name: string; path: string }>
  return nodes.map((n) => n.path)
}

// ---------------------------------------------------------------------------
// Command convenience wrappers
// ---------------------------------------------------------------------------

export async function listCommands(): Promise<unknown[]> {
  const client = getOpenCodeClient()
  const result = await client.command.list({ directory: dir() })
  return unwrap(result) as unknown[]
}

export async function executeCommand(
  sessionId: string,
  command: string,
  args?: string[],
  options?: {
    messageID?: string
    agent?: string
    model?: { providerID: string; modelID: string }
  },
): Promise<unknown> {
  const client = getOpenCodeClient()
  const result = await client.session.command({
    sessionID: sessionId,
    directory: dir(),
    command,
    ...(args && args.length > 0 && { arguments: args.join(' ') }),
    ...(options?.messageID && { messageID: options.messageID }),
    ...(options?.agent && { agent: options.agent }),
    // Note: session.command takes model as a string, not an object
    ...(options?.model && { model: `${options.model.providerID}/${options.model.modelID}` }),
  })
  return unwrap(result)
}

// ---------------------------------------------------------------------------
// MCP convenience wrappers
// ---------------------------------------------------------------------------

export async function getMCPStatus(): Promise<unknown> {
  const client = getOpenCodeClient()
  const result = await client.mcp.status({ directory: dir() })
  return unwrap(result)
}

export async function addMCPServer(
  name: string,
  config: MCPServerConfig,
): Promise<unknown> {
  const client = getOpenCodeClient()
  const result = await client.mcp.add({
    directory: dir(),
    name,
    config: config as { type: 'local'; command: string[] },
  })
  return unwrap(result)
}

export async function connectMCP(name: string): Promise<boolean> {
  const client = getOpenCodeClient()
  const result = await client.mcp.connect({ name, directory: dir() })
  unwrap(result)
  return true
}

export async function disconnectMCP(name: string): Promise<boolean> {
  const client = getOpenCodeClient()
  const result = await client.mcp.disconnect({ name, directory: dir() })
  unwrap(result)
  return true
}

// ---------------------------------------------------------------------------
// Tool convenience wrappers
// ---------------------------------------------------------------------------

export async function getToolIds(): Promise<string[]> {
  const client = getOpenCodeClient()
  const result = await client.tool.ids({ directory: dir() })
  return unwrap(result) as string[]
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export async function isReady(): Promise<boolean> {
  try {
    const client = getOpenCodeClient()
    const result = await client.session.list({ directory: dir() })
    unwrap(result)
    return true
  } catch {
    return false
  }
}
