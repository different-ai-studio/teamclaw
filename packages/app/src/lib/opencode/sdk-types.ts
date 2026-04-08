/**
 * Centralized SDK type re-exports and TeamClaw-specific type extensions.
 *
 * This file replaces the hand-written types.ts by re-exporting types from
 * @opencode-ai/sdk/v2 and defining TeamClaw-specific types that either
 * don't exist in the SDK or need to be shaped differently for our app.
 *
 * Consumers should import from this file instead of '@/lib/opencode/types'.
 */

// ---------------------------------------------------------------------------
// Re-exports from @opencode-ai/sdk/v2
// ---------------------------------------------------------------------------

// Core
export type {
  Session,
  SnapshotFileDiff,
} from '@opencode-ai/sdk/v2'

// Messages
export type {
  UserMessage,
  AssistantMessage,
  Message as SDKMessage,
} from '@opencode-ai/sdk/v2'

// Parts
export type {
  TextPart,
  ReasoningPart,
  ToolPart,
  SubtaskPart,
  FilePart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  RetryPart,
  AgentPart,
  CompactionPart,
  Part,
  ToolState,
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
} from '@opencode-ai/sdk/v2'

// Inputs
export type {
  TextPartInput,
  FilePartInput,
  AgentPartInput,
  SubtaskPartInput,
} from '@opencode-ai/sdk/v2'

// Events
export type {
  EventMessageUpdated,
  EventMessagePartUpdated,
  EventMessagePartDelta,
  EventMessageRemoved,
  EventSessionCreated,
  EventSessionUpdated,
  EventSessionDeleted,
  EventSessionStatus,
  EventSessionIdle,
  EventSessionError,
  EventSessionDiff,
  EventPermissionAsked,
  EventPermissionReplied,
  EventQuestionAsked,
  EventQuestionReplied,
  EventTodoUpdated,
  EventFileWatcherUpdated,
  Event,
} from '@opencode-ai/sdk/v2'

// Permission
export type {
  PermissionRuleset,
  PermissionRequest,
} from '@opencode-ai/sdk/v2'

// Question
export type {
  QuestionInfo,
  QuestionOption as SDKQuestionOption,
  QuestionRequest,
} from '@opencode-ai/sdk/v2'

// Todo (from SDK)
export type { Todo as SDKTodo } from '@opencode-ai/sdk/v2'

// MCP (from SDK)
export type {
  McpStatus,
  McpStatusConnected,
  McpStatusDisabled,
  McpStatusFailed,
  McpStatusNeedsAuth,
  McpStatusNeedsClientRegistration,
} from '@opencode-ai/sdk/v2'

// Command (from SDK)
export type { Command as SDKCommand } from '@opencode-ai/sdk/v2'

// Project (from SDK)
export type { Project as SDKProject } from '@opencode-ai/sdk/v2'

// Provider
export type {
  ProviderAuthError,
  UnknownError,
  MessageOutputLengthError,
  MessageAbortedError,
  StructuredOutputError,
  ContextOverflowError,
  ApiError,
} from '@opencode-ai/sdk/v2'

// ---------------------------------------------------------------------------
// TeamClaw-specific types (not in SDK, or shaped for app compatibility)
// ---------------------------------------------------------------------------

/**
 * Configuration for connecting to an OpenCode instance.
 */
export interface OpenCodeConfig {
  baseUrl: string
  password?: string
  workspacePath?: string
}

/**
 * Backward-compatible FileDiff type used throughout the app.
 * Maps to SnapshotFileDiff in the SDK but with the field names the app expects.
 */
export interface FileDiff {
  file: string
  before: string
  after: string
  additions: number
  deletions: number
}

/**
 * Flattened message type used throughout the app UI layer.
 * Combines message info with its parts for convenience.
 */
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

/**
 * App-level message part type.
 * Superset shape that can represent any part type with optional fields.
 */
export interface MessagePart {
  id: string
  sessionID: string
  messageID: string
  type: 'text' | 'tool' | 'tool-call' | 'tool-result' | 'step-start' | 'step-finish' | 'reasoning'
  text?: string
  toolCall?: ToolCallInfo
  toolResult?: ToolResult
  tool?: string
  callID?: string
  state?: {
    status: 'pending' | 'running' | 'completed' | 'error'
    input: Record<string, unknown>
    raw?: string
    output?: unknown
    result?: unknown
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

/**
 * Alias kept for backward compatibility.
 */
export type SessionListItem = import('@opencode-ai/sdk/v2').Session

/**
 * Tool call lifecycle status.
 */
export type ToolCallStatus = 'calling' | 'completed' | 'failed' | 'waiting'

// ---------------------------------------------------------------------------
// Handler event types (used by SSE handlers and stores)
// ---------------------------------------------------------------------------

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
  text?: string
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

export interface ToolExecutingEvent {
  toolCallId: string
  toolName: string
  status: 'running' | 'completed' | 'failed'
  arguments?: Record<string, unknown>
  result?: string
  duration?: number
  sessionId?: string
  messageId?: string
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

export interface PermissionAskedEvent {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  always?: string[]
  metadata?: Record<string, unknown>
  tool?: {
    callID: string
    messageID: string
  }
}

export interface PermissionReplyRequest {
  reply: 'once' | 'always' | 'reject'
}

export interface ErrorEvent {
  code: string
  message: string
  details?: Record<string, unknown>
}

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

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

// ---------------------------------------------------------------------------
// Todo / Question / Command (app-level shapes)
// ---------------------------------------------------------------------------

export interface Todo {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
}

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

export interface Command {
  name: string
  description?: string
  template?: string
  agent?: string
  model?: string
  subtask?: boolean
}

// ---------------------------------------------------------------------------
// MCP types (app-level, kept for backward compatibility)
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
  type: 'local' | 'remote'
  enabled?: boolean
  command?: string[]
  environment?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  timeout?: number
}

export type MCPServerStatus = 'connected' | 'disabled' | 'failed' | 'needs_auth' | 'needs_client_registration'

export interface MCPRuntimeStatus {
  status: MCPServerStatus
  error?: string
}

export type MCPStatusMap = Record<string, MCPRuntimeStatus>

// ---------------------------------------------------------------------------
// Project type (app-level)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SSE event types
// ---------------------------------------------------------------------------

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

export interface OpenCodeSSEEvent<T = unknown> {
  type: SSEEventType
  data: T
}

// ---------------------------------------------------------------------------
// Message part input types for sending messages (app-level)
// ---------------------------------------------------------------------------

export type SendMessageTextPart = {
  type: 'text'
  text: string
}

export type SendMessageFilePart = {
  type: 'file'
  url: string
  mime: string
  filename?: string
}

export interface SendMessageRequest {
  parts: Array<SendMessageTextPart | SendMessageFilePart>
  agent?: string
  systemPrompt?: string
}
