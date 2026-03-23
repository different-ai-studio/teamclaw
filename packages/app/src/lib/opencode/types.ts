// OpenCode API Types (updated for actual API)

export interface OpenCodeConfig {
  baseUrl: string
  password?: string
  workspacePath?: string  // Workspace directory path for OpenCode to use
}

// File Diff Types (defined early as it's used in Session)
export interface FileDiff {
  file: string
  before: string
  after: string
  additions: number
  deletions: number
}

// Session Types
export interface Session {
  id: string
  slug: string
  version: string
  projectID: string
  directory: string
  parentID?: string  // Parent session ID for child/subagent sessions
  title: string
  time: {
    created: number
    updated: number
    archived?: number  // Timestamp when session was archived
  }
  summary?: {
    additions: number
    deletions: number
    files: number
    diffs?: FileDiff[]
  }
}

export type SessionListItem = Session

export type CreateSessionRequest = Record<string, never>

// Message Types
export interface Message {
  info: MessageInfo
  parts: MessagePart[]
}

export interface MessageInfo {
  id: string
  sessionID: string
  role: 'user' | 'assistant'
  time: {
    created: number
    completed?: number
  }
  parentID?: string
  modelID?: string
  providerID?: string
  mode?: string
  agent?: string
  path?: {
    cwd: string
    root: string
  }
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  finish?: string
}

export interface MessagePart {
  id: string
  sessionID: string
  messageID: string
  type: 'text' | 'tool' | 'tool-call' | 'tool-result' | 'step-start' | 'step-finish' | 'reasoning'
  text?: string
  toolCall?: ToolCallInfo
  toolResult?: ToolResult
  // For 'tool' type parts (from OpenCode)
  tool?: string
  callID?: string
  state?: {
    status: 'pending' | 'running' | 'completed' | 'error'
    input: Record<string, unknown>
    raw?: string
    output?: unknown  // MCP tools may use output instead of raw
    result?: unknown  // Alternative result field
  }
  time?: {
    start: number
    end?: number
  }
  snapshot?: string
  reason?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}

export interface ToolCallInfo {
  name: string
  id: string
  input: Record<string, unknown>
}

export interface ToolResult {
  type: 'text' | 'error'
  content: string
  error?: string
}

// Message part types for sending messages
export type SendMessageTextPart = {
  type: 'text'
  text: string
}

export type SendMessageFilePart = {
  type: 'file'
  url: string  // Can be data URL (data:mime;base64,...) or file path
  mime: string
  filename?: string
}

export interface SendMessageRequest {
  parts: Array<SendMessageTextPart | SendMessageFilePart>
  agent?: string  // Agent name: 'plan' for planning mode, 'build' for implementation mode
  systemPrompt?: string  // System prompt to guide AI behavior
}

// Mentioned person in user input (for @ mentions)
export interface MentionedPerson {
  id: string
  name: string
  email?: string
}

// SSE Event Types
export type SSEEventType =
  | 'message.created'
  | 'message.part.created'
  | 'message.part.updated'
  | 'message.completed'
  | 'tool.executing'
  | 'permission.asked'
  | 'permission.replied'
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'error'
  | 'server.ready'

export interface SSEEvent<T = unknown> {
  type: SSEEventType
  data: T
}

// Message Events
export interface MessageCreatedEvent {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  createdAt: string
}

export interface MessagePartCreatedEvent {
  messageId: string
  partId: string
  type: 'text' | 'tool_call' | 'tool_result' | 'text_delta' | 'reasoning' | 'step-start' | 'step-finish'
  content?: string
  text?: string  // For reasoning type
  tool?: ToolCallInfo
  result?: ToolResult
  duration?: number
}

export interface MessagePartUpdatedEvent {
  messageId: string
  partId: string
  type: 'text_delta' | 'reasoning_delta'
  delta: string
  stopReason?: 'end_turn' | 'max_tokens' | null
  usage?: TokenUsage
}

export interface MessageCompletedEvent {
  messageId: string
  sessionId: string
  finalContent: string
  usage: TokenUsage
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  cost?: number
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

// Tool Events
export interface ToolExecutingEvent {
  toolCallId: string
  toolName: string
  status: 'running' | 'completed' | 'failed'
  arguments?: Record<string, unknown>
  result?: string
  duration?: number
  // Session context - used to verify tool events belong to the correct session
  sessionId?: string
  messageId?: string
  // For task tool (subagent) - metadata from ctx.metadata()
  title?: string
  metadata?: {
    title?: string
    sessionId?: string
    model?: { providerID: string; modelID: string }
    summary?: Array<{
      id: string
      tool: string
      state: {
        status: string
        title?: string
      }
    }>
  }
}

// Permission Events
export interface PermissionAskedEvent {
  id: string
  sessionID: string
  permission: string  // e.g., "write", "bash", "read"
  patterns: string[]
  always?: string[]   // patterns to add to allowlist when reply is "always"
  metadata?: Record<string, unknown>
  tool?: {
    callID: string
    messageID: string
  }
}

export interface PermissionReplyRequest {
  reply: 'once' | 'always' | 'reject'
}

// Error Event
export interface ErrorEvent {
  code: string
  message: string
  details?: Record<string, unknown>
}

// Provider Types
export interface Provider {
  name: string
  models: string[]
  configured: boolean
}

// Project Types
export interface Project {
  path: string
  name: string
  version?: string
  git?: {
    branch: string
    remote: string
    hasUncommitted: boolean
  }
}

// Question Tool Types
export interface QuestionOption {
  id?: string
  label: string
  value?: string
}

export interface Question {
  id?: string
  question: string
  header?: string
  options: QuestionOption[]
}

export interface QuestionToolInput {
  questions: Question[]
}

// SSE Event for question.asked
export interface QuestionAskedEvent {
  id: string
  sessionId: string
  questions: Question[]
  tool?: {
    callId: string
    messageId: string
  }
}

// Todo Types
export interface Todo {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
}

export interface TodoUpdatedEvent {
  sessionId: string
  todos: Todo[]
}

export interface SessionDiffEvent {
  sessionId: string
  diff: FileDiff[]
}

// Session Error Types
export interface SessionErrorEvent {
  sessionId?: string
  error?: {
    name: string
    data: {
      message: string
      providerID?: string
      statusCode?: number
      isRetryable?: boolean
    }
  }
}

// Command Types
export interface Command {
  name: string
  description?: string
  template?: string
  agent?: string
  model?: string
  subtask?: boolean
}

// MCP Types
export interface MCPServerConfig {
  type: 'local' | 'remote'
  enabled?: boolean
  command?: string[]  // for local servers
  environment?: Record<string, string>  // for local servers
  url?: string  // for remote servers
  headers?: Record<string, string>  // for remote servers
  timeout?: number
}

export interface MCPConfig {
  [serverName: string]: MCPServerConfig
}

export interface OpenCodeJsonConfig {
  $schema?: string
  mcp?: MCPConfig
  [key: string]: unknown
}

// MCP Runtime Status (from OpenCode GET /mcp)
export type MCPServerStatus = 'connected' | 'disabled' | 'failed' | 'needs_auth' | 'needs_client_registration'

export interface MCPRuntimeStatus {
  status: MCPServerStatus
  error?: string
}

export type MCPStatusMap = Record<string, MCPRuntimeStatus>
