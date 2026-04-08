import type { StoreApi } from 'zustand';
import type {
  PermissionAskedEvent,
  Question,
  Todo,
  FileDiff,
  TodoUpdatedEvent,
  SessionDiffEvent,
  SessionErrorEvent,
  SendMessageFilePart,
} from '@/lib/opencode/sdk-types';
import type { TerminalPromptKind } from "@/lib/terminal-interaction";
import type {
  SessionCreatedEvent,
  SessionUpdatedEvent,
  ExternalMessageEvent,
  SessionBusyEvent,
  SessionIdleEvent,
  SessionStatusEvent,
  SessionStatusInfo,
  OpenCodeSSEEvent,
} from '@/lib/opencode/sdk-sse';
import type { SearchResult } from '@/stores/knowledge';
import type {
  MessageCreatedEvent,
  MessagePartCreatedEvent,
  MessagePartUpdatedEvent,
  MessageCompletedEvent,
  ToolExecutingEvent,
  QuestionAskedEvent,
} from '@/lib/opencode/sdk-types';

// Re-export types for convenience
export type { PermissionAskedEvent };

export interface ToolCallPermission {
  id: string;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  decision: "pending" | "approved" | "denied" | "allowlisted";
}

export interface ToolCall {
  id: string;
  name: string;
  status: "calling" | "completed" | "failed" | "waiting";
  arguments: Record<string, unknown>;
  result?: unknown;
  duration?: number;
  startTime: Date;
  permission?: ToolCallPermission;
  // For question tool
  questions?: Question[];
  // For task tool (subagent) metadata
  metadata?: {
    title?: string;
    sessionId?: string;
    model?: { providerID: string; modelID: string };
    summary?: Array<{
      id: string;
      tool: string;
      state: {
        status: string;
        title?: string;
      };
    }>;
  };
}

export interface PendingQuestionState {
  questionId: string; // The question.asked event ID, or a local synthetic question id
  toolCallId: string;
  messageId: string;
  questions: Question[];
  source?: "opencode" | "terminal_input";
  terminalInputContext?: {
    command?: string;
    prompt?: string;
    kind?: TerminalPromptKind;
  };
}

export interface MessagePart {
  id: string;
  type: string;
  content?: string;
  text?: string; // For reasoning type
  tool?: {
    name: string;
    id: string;
    input: Record<string, unknown>;
  };
  result?: {
    type: string;
    content: string;
  };
}

export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: MessagePart[];
  toolCalls?: ToolCall[];
  timestamp: Date;
  isStreaming?: boolean;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  cost?: number;
  permissionRequest?: PermissionAskedEvent;
  // Model information from OpenCode (stored per-message)
  modelID?: string;
  providerID?: string;
  agent?: string; // Agent/skill name from OpenCode
  retrievedChunks?: SearchResult[]; // RAG 检索到的文档片段
}

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  messageCount?: number;
  directory?: string; // Working directory for this session
  parentID?: string; // Parent session ID (for child/subagent sessions)
}

// Child session (subagent) streaming state
export interface ChildStreamingState {
  sessionId: string;
  text: string;
  reasoning: string;
  isStreaming: boolean;
}

// Queued message type
export interface QueuedMessage {
  id: string;
  content: string;
  timestamp: Date;
}

// Selected model for chat
export interface SelectedModel {
  providerID: string;
  modelID: string;
  name: string;
}

export interface SessionState {
  // State
  sessions: Session[];
  pinnedSessionIds: string[];
  activeSessionId: string | null;
  isLoading: boolean;
  isLoadingMore: boolean; // Loading more sessions (UI pagination)
  hasMoreSessions: boolean; // Whether there are more sessions to show
  visibleSessionCount: number; // How many sessions are currently visible in sidebar
  error: string | null;
  isConnected: boolean;

  // Selected model
  selectedModel: SelectedModel | null;

  // Streaming state — moved to streaming.ts (useStreamingStore)
  // streamingMessageId, streamingContent, childSessionStreaming are now in useStreamingStore

  // Message queue
  messageQueue: QueuedMessage[];

  // Permission request (scoped to child session lifecycle)
  // When child session ends (idle) or parent session switches, this is cleared
  pendingPermission: PermissionAskedEvent | null;
  // Child session ID that the permission belongs to (for lifecycle binding)
  pendingPermissionChildSessionId: string | null;

  // Pending question (from question tool)
  pendingQuestion: PendingQuestionState | null;

  // Todo list (from todowrite tool)
  todos: Todo[];

  // Session diff (file changes in current session)
  sessionDiff: FileDiff[];

  // Session error
  sessionError: SessionErrorEvent | null;

  // Session status (mirrors OpenCode's server-side session status)
  sessionStatus: SessionStatusInfo | null;

  // childSessionStreaming — moved to streaming.ts (useStreamingStore)

  // Inactivity warning (no SSE events for 30+ seconds during streaming)
  inactivityWarning: boolean;

  // Highlighted session IDs (newly created externally, auto-clears after 5s)
  highlightedSessionIds: string[];

  // Draft input text (preserved when navigating away from chat)
  draftInput: string;

  // Actions - Session management
  loadSessions: (workspacePath?: string) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  createSession: (workspacePath?: string) => Promise<Session | null>;
  setActiveSession: (id: string) => Promise<void>;
  archiveSession: (id: string) => Promise<void>;
  updateSessionTitle: (id: string, title: string) => Promise<void>;
  toggleSessionPinned: (id: string) => void;
  resetSessions: () => void;

  // Actions - Model selection
  setSelectedModel: (model: SelectedModel | null) => void;

  // Actions - Draft input
  setDraftInput: (input: string) => void;
  clearDraftInput: () => void;

  // Actions - Message handling
  sendMessage: (content: string, agent?: string, imageParts?: SendMessageFilePart[]) => Promise<void>;
  autoInjectKnowledge: (userMessage: string) => Promise<{ context?: string; chunks?: SearchResult[] }>;
  abortSession: () => Promise<void>;
  removeFromQueue: (id: string) => void;

  // Actions - SSE event handlers
  handleMessageCreated: (event: MessageCreatedEvent) => void;
  handleMessagePartCreated: (event: MessagePartCreatedEvent) => void;
  handleMessagePartUpdated: (event: MessagePartUpdatedEvent) => void;
  handleMessageCompleted: (event: MessageCompletedEvent) => void;
  handleToolExecuting: (event: ToolExecutingEvent) => void;
  handlePermissionAsked: (event: PermissionAskedEvent) => void;

  // Actions - Permission
  replyPermission: (
    permissionId: string,
    decision: "allow" | "deny" | "always",
  ) => Promise<void>;
  pollPermissions: () => Promise<void>;

  // Actions - Question
  answerQuestion: (answers: Record<string, string>) => Promise<void>;
  setPendingQuestion: (
    question: PendingQuestionState | null,
  ) => void;
  handleQuestionAsked: (event: QuestionAskedEvent) => void;

  // Actions - Session lifecycle (SSE global events)
  handleSessionCreated: (event: SessionCreatedEvent) => void;
  handleSessionUpdated: (event: SessionUpdatedEvent) => void;
  clearHighlightedSession: (sessionId: string) => void;

  // Actions - Child session (subagent) streaming
  handleChildSessionEvent: (event: OpenCodeSSEEvent) => void;

  // Actions - External message handling
  handleExternalMessage: (event: ExternalMessageEvent) => void;
  reloadActiveSessionMessages: () => Promise<void>;

  // Actions - Session status tracking
  handleSessionStatus: (event: SessionStatusEvent) => void;
  handleSessionBusy: (event: SessionBusyEvent) => void;
  handleSessionIdle: (event: SessionIdleEvent) => void;

  // Actions - Todo, Diff, Error
  handleTodoUpdated: (event: TodoUpdatedEvent) => void;
  handleSessionDiff: (event: SessionDiffEvent) => void;
  handleFileEdited: (file: string) => void;
  refreshSessionDiff: () => Promise<void>;
  handleSessionError: (event: SessionErrorEvent) => void;
  clearSessionError: () => void;

  // Actions - Tool call management
  forceCompleteToolCall: (toolCallId: string) => void;

  // Actions - Dashboard batch loading
  dashboardLoading: boolean;
  dashboardLoadProgress: { loaded: number; total: number };
  dashboardLoadError?: string;
  loadAllSessionMessages: (workspacePath?: string) => Promise<void>;

  // Actions - Connection
  setConnected: (connected: boolean) => void;
  setError: (error: string | null) => void;
  setInactivityWarning: (active: boolean) => void;

  // Getters
  getActiveSession: () => Session | undefined;
  getSessionMessages: (sessionId: string) => Message[];
}

// Zustand action creator helper types
export type SessionSet = StoreApi<SessionState>['setState'];
export type SessionGet = StoreApi<SessionState>['getState'];
