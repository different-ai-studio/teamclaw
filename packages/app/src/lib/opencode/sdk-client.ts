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
  MCPStatusMap,
  SendMessageRequest,
  PermissionReplyRequest,
  PermissionAskedEvent,
  Session,
  SessionListItem,
  Message,
  Project,
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
 * Compatibility wrapper that exposes the same method names as the old
 * OpenCodeClient class so existing consumers (`const c = getRawSdkClient();
 * client.sendMessage(...)`) continue to work without changes.
 *
 * Each method delegates to the corresponding named export below.
 */
export interface OpenCodeClientCompat {
  createSession: typeof createSession
  listSessions: typeof listSessions
  getSession: typeof getSession
  deleteSession: typeof deleteSession
  archiveSession: typeof archiveSession
  updateSession: typeof updateSession
  abortSession: typeof abortSession
  getMessages: typeof getMessages
  sendMessage: typeof sendMessage
  sendMessageWithParts: typeof sendMessageWithParts
  sendMessageAsync: typeof sendMessageAsync
  sendMessageWithPartsAsync: typeof sendMessageWithPartsAsync
  replyQuestion: typeof replyQuestion
  rejectQuestion: typeof rejectQuestion
  listQuestions: typeof listQuestions
  getTodos: typeof getTodos
  getSessionDiff: typeof getSessionDiff
  getFileStatus: typeof getFileStatus
  listPermissions: typeof listPermissions
  replyPermission: typeof replyPermission
  getProviders: typeof getProviders
  getConfigProviders: typeof getConfigProviders
  getConfig: typeof getConfig
  updateConfig: typeof updateConfig
  setAuth: typeof setAuth
  deleteAuth: typeof deleteAuth
  getAuthMethods: typeof getAuthMethods
  oauthAuthorize: typeof oauthAuthorize
  oauthCallback: typeof oauthCallback
  getProject: typeof getProject
  readFile: typeof readFile
  listDirectory: typeof listDirectory
  listCommands: typeof listCommands
  executeCommand: typeof executeCommand
  getMCPStatus: typeof getMCPStatus
  addMCPServer: typeof addMCPServer
  connectMCP: typeof connectMCP
  disconnectMCP: typeof disconnectMCP
  getToolIds: typeof getToolIds
  isReady: typeof isReady
  setWorkspacePath: (path: string | null | undefined) => void
}

let compatClient: OpenCodeClientCompat | null = null

function buildCompat(): OpenCodeClientCompat {
  return {
    createSession, listSessions, getSession, deleteSession,
    archiveSession, updateSession, abortSession, getMessages,
    sendMessage, sendMessageWithParts, sendMessageAsync,
    sendMessageWithPartsAsync, replyQuestion, rejectQuestion,
    listQuestions, getTodos, getSessionDiff, getFileStatus,
    listPermissions, replyPermission, getProviders, getConfigProviders,
    getConfig, updateConfig, setAuth, deleteAuth, getAuthMethods,
    oauthAuthorize, oauthCallback, getProject, readFile, listDirectory,
    listCommands, executeCommand, getMCPStatus, addMCPServer,
    connectMCP, disconnectMCP, getToolIds, isReady,
    setWorkspacePath: (path: string | null | undefined) =>
      updateOpenCodeClientWorkspace(path ?? null),
  }
}

/**
 * Return a compatibility client object with the same method names as the old
 * OpenCodeClient class. Throws if initOpenCodeClient() has not been called.
 */
export function getOpenCodeClient(): OpenCodeClientCompat {
  if (!sdkClient) {
    throw new Error('OpenCodeClient not initialized. Call initOpenCodeClient() first.')
  }
  if (!compatClient) {
    compatClient = buildCompat()
  }
  return compatClient
}

/**
 * Return the raw SDK OpencodeClient for advanced/direct use.
 */
export function getRawSdkClient(): OpencodeClient {
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

export async function createSession(): Promise<Session> {
  const c = getRawSdkClient()
  const result = await c.session.create({ directory: dir() })
  return unwrap(result) as unknown as Session
}

export async function listSessions(options?: {
  directory?: string
  roots?: boolean
}): Promise<SessionListItem[]> {
  const c = getRawSdkClient()
  const result = await c.session.list({
    directory: options?.directory || dir(),
    roots: options?.roots,
  })
  return unwrap(result) as unknown as SessionListItem[]
}

export async function getSession(id: string): Promise<Session> {
  const c = getRawSdkClient()
  const result = await c.session.get({ sessionID: id, directory: dir() })
  return unwrap(result) as unknown as Session
}

export async function deleteSession(id: string): Promise<void> {
  const c = getRawSdkClient()
  const result = await c.session.delete({ sessionID: id, directory: dir() })
  unwrap(result)
}

export async function archiveSession(id: string, directory?: string): Promise<void> {
  const c = getRawSdkClient()
  const result = await c.session.update({
    sessionID: id,
    directory: directory || dir(),
    time: { archived: Date.now() },
  })
  unwrap(result)
}

export async function updateSession(
  id: string,
  updates: { title?: string },
): Promise<Session> {
  const c = getRawSdkClient()
  const result = await c.session.update({
    sessionID: id,
    directory: dir(),
    ...updates,
  })
  return unwrap(result) as never
}

export async function abortSession(id: string): Promise<boolean> {
  const c = getRawSdkClient()
  const result = await c.session.abort({ sessionID: id, directory: dir() })
  unwrap(result)
  return true
}

// ---------------------------------------------------------------------------
// Message convenience wrappers
// ---------------------------------------------------------------------------

export async function getMessages(sessionId: string): Promise<Message[]> {
  const c = getRawSdkClient()
  const result = await c.session.messages({
    sessionID: sessionId,
    directory: dir(),
  })
  return unwrap(result) as unknown as Message[]
}

export async function sendMessage(
  sessionId: string,
  content: string,
  model?: { providerID: string; modelID: string },
  agent?: string,
  systemPrompt?: string,
): Promise<Message> {
  const c = getRawSdkClient()
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

  const result = await c.session.prompt({
    sessionID: sessionId,
    directory: dir(),
    parts: [{ type: 'text', text: content }],
    ...(model && { model }),
    ...(agent && { agent }),
    ...(trimmedSystem && { system: trimmedSystem }),
  })
  return unwrap(result) as unknown as Message
}

export async function sendMessageWithParts(
  sessionId: string,
  parts: SendMessageRequest['parts'],
  model?: { providerID: string; modelID: string },
  systemPrompt?: string,
): Promise<Message> {
  const c = getRawSdkClient()
  const result = await c.session.prompt({
    sessionID: sessionId,
    directory: dir(),
    parts: parts as Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string }>,
    ...(model && { model }),
    ...(systemPrompt?.trim() && { system: systemPrompt.trim() }),
  })
  return unwrap(result) as never
}

export async function sendMessageAsync(
  sessionId: string,
  content: string,
  model?: { providerID: string; modelID: string },
  agent?: string,
  systemPrompt?: string,
): Promise<void> {
  const c = getRawSdkClient()
  const result = await c.session.promptAsync({
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
  const c = getRawSdkClient()
  const result = await c.session.promptAsync({
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
  const c = getRawSdkClient()
  const result = await c.question.reply({
    requestID,
    directory: dir(),
    answers,
  })
  unwrap(result)
  return true
}

export async function rejectQuestion(requestID: string): Promise<boolean> {
  const c = getRawSdkClient()
  const result = await c.question.reject({
    requestID,
    directory: dir(),
  })
  unwrap(result)
  return true
}

export async function listQuestions(): Promise<unknown[]> {
  const c = getRawSdkClient()
  const result = await c.question.list({ directory: dir() })
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
  const c = getRawSdkClient()
  const result = await c.session.todo({
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
  const c = getRawSdkClient()
  const result = await c.session.diff({
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
  const c = getRawSdkClient()
  const result = await c.file.status({ directory: dir() })
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

export async function listPermissions(): Promise<PermissionAskedEvent[]> {
  const c = getRawSdkClient()
  const result = await c.permission.list({ directory: dir() })
  return unwrap(result) as unknown as PermissionAskedEvent[]
}

export async function replyPermission(
  permissionId: string,
  request: PermissionReplyRequest,
): Promise<void> {
  const c = getRawSdkClient()
  const result = await c.permission.reply({
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
  const c = getRawSdkClient()
  const result = await c.provider.list({ directory: dir() })
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
  const c = getRawSdkClient()
  const result = await c.config.providers({ directory: dir() })
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
  const c = getRawSdkClient()
  const result = await c.config.get({ directory: dir() })
  return unwrap(result) as { model?: string }
}

export async function updateConfig(
  config: { model?: string },
): Promise<{ model?: string }> {
  const c = getRawSdkClient()
  const result = await c.config.update({
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
  const c = getRawSdkClient()
  const result = await c.auth.set({
    providerID: providerId,
    auth: auth as { type: 'api'; key: string },
  })
  unwrap(result)
  return true
}

export async function deleteAuth(providerId: string): Promise<boolean> {
  const c = getRawSdkClient()
  const result = await c.auth.remove({ providerID: providerId })
  unwrap(result)
  return true
}

export async function getAuthMethods(): Promise<
  Record<
    string,
    Array<{ type: 'oauth' | 'api'; label: string; prompts?: unknown[] }>
  >
> {
  const c = getRawSdkClient()
  const result = await c.provider.auth({ directory: dir() })
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
  const c = getRawSdkClient()
  const result = await c.provider.oauth.authorize({
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
  const c = getRawSdkClient()
  const result = await c.provider.oauth.callback({
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

export async function getProject(): Promise<Project> {
  const c = getRawSdkClient()
  const result = await c.project.current({ directory: dir() })
  return unwrap(result) as never
}

// ---------------------------------------------------------------------------
// File convenience wrappers
// ---------------------------------------------------------------------------

export async function readFile(path: string): Promise<string> {
  const c = getRawSdkClient()
  const result = await c.file.read({ directory: dir(), path })
  // SDK returns FileContent { type, content, ... } — extract the text content
  const fileContent = unwrap(result) as unknown as { type: string; content: string }
  return fileContent.content
}

export async function listDirectory(path: string): Promise<string[]> {
  const c = getRawSdkClient()
  const result = await c.file.list({ directory: dir(), path })
  // SDK returns FileNode[] { name, path, absolute, type, ignored }
  const nodes = unwrap(result) as unknown as Array<{ name: string; path: string }>
  return nodes.map((n) => n.path)
}

// ---------------------------------------------------------------------------
// Command convenience wrappers
// ---------------------------------------------------------------------------

export async function listCommands(): Promise<Command[]> {
  const c = getRawSdkClient()
  const result = await c.command.list({ directory: dir() })
  return unwrap(result) as unknown as Command[]
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
): Promise<Message> {
  const c = getRawSdkClient()
  const result = await c.session.command({
    sessionID: sessionId,
    directory: dir(),
    command,
    ...(args && args.length > 0 && { arguments: args.join(' ') }),
    ...(options?.messageID && { messageID: options.messageID }),
    ...(options?.agent && { agent: options.agent }),
    // Note: session.command takes model as a string, not an object
    ...(options?.model && { model: `${options.model.providerID}/${options.model.modelID}` }),
  })
  return unwrap(result) as never
}

// ---------------------------------------------------------------------------
// MCP convenience wrappers
// ---------------------------------------------------------------------------

export async function getMCPStatus(): Promise<MCPStatusMap> {
  const c = getRawSdkClient()
  const result = await c.mcp.status({ directory: dir() })
  return unwrap(result) as never
}

export async function addMCPServer(
  name: string,
  config: MCPServerConfig,
): Promise<MCPStatusMap> {
  const c = getRawSdkClient()
  const result = await c.mcp.add({
    directory: dir(),
    name,
    config: config as { type: 'local'; command: string[] },
  })
  return unwrap(result) as never
}

export async function connectMCP(name: string): Promise<boolean> {
  const c = getRawSdkClient()
  const result = await c.mcp.connect({ name, directory: dir() })
  unwrap(result)
  return true
}

export async function disconnectMCP(name: string): Promise<boolean> {
  const c = getRawSdkClient()
  const result = await c.mcp.disconnect({ name, directory: dir() })
  unwrap(result)
  return true
}

// ---------------------------------------------------------------------------
// Tool convenience wrappers
// ---------------------------------------------------------------------------

export async function getToolIds(): Promise<string[]> {
  const c = getRawSdkClient()
  const result = await c.tool.ids({ directory: dir() })
  return unwrap(result) as string[]
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export async function isReady(): Promise<boolean> {
  try {
    const c = getRawSdkClient()
    const result = await c.session.list({ directory: dir() })
    unwrap(result)
    return true
  } catch {
    return false
  }
}
