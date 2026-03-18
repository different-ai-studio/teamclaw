import type {
  MessageCreatedEvent,
  MessagePartCreatedEvent,
  MessagePartUpdatedEvent,
  MessageCompletedEvent,
  ToolExecutingEvent,
  PermissionAskedEvent,
  ErrorEvent,
} from './types'

// Question asked event
export interface QuestionAskedEvent {
  id: string
  sessionId: string
  questions: Array<{
    id?: string
    question: string
    header?: string
    options: Array<{ id?: string; label: string; value?: string }>
  }>
  tool?: {
    callId: string
    messageId: string
  }
}

// Todo updated event
export interface TodoUpdatedEvent {
  sessionId: string
  todos: Array<{
    id: string
    content: string
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
    priority: 'high' | 'medium' | 'low'
  }>
}

// Session diff event
export interface SessionDiffEvent {
  sessionId: string
  diff: Array<{
    file: string
    before: string
    after: string
    additions: number
    deletions: number
  }>
}

// Session error event
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

// File edited event
export interface FileEditedEvent {
  file: string
}

// Session lifecycle events (global, not filtered by active session)
export interface SessionCreatedEvent {
  sessionId: string
  directory?: string
  parentID?: string
}

export interface SessionUpdatedEvent {
  sessionId: string
  directory?: string
}

// External message detected (message.updated for a message not in local state)
// This fires when a message is sent externally (e.g., via Feishu gateway)
export interface ExternalMessageEvent {
  sessionId: string
  messageId: string
  role: 'user' | 'assistant'
}

// Session status events — mirrors OpenCode's SessionStatus.Info
// idle: no active processing
// busy: actively processing (LLM streaming, tool calls)
// retry: provider error, retrying with backoff
export type SessionStatusInfo =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt: number; message: string; next: number }

export interface SessionStatusEvent {
  sessionId: string
  status: SessionStatusInfo
}

// Legacy aliases for backward compatibility
export interface SessionBusyEvent {
  sessionId: string
}

export interface SessionIdleEvent {
  sessionId: string
}

export interface SSEHandlers {
  onMessageCreated?: (event: MessageCreatedEvent) => void
  onMessagePartCreated?: (event: MessagePartCreatedEvent) => void
  onMessagePartUpdated?: (event: MessagePartUpdatedEvent) => void
  onMessageCompleted?: (event: MessageCompletedEvent) => void
  onToolExecuting?: (event: ToolExecutingEvent) => void
  onPermissionAsked?: (event: PermissionAskedEvent) => void
  onQuestionAsked?: (event: QuestionAskedEvent) => void
  onTodoUpdated?: (event: TodoUpdatedEvent) => void
  onSessionDiff?: (event: SessionDiffEvent) => void
  onSessionError?: (event: SessionErrorEvent) => void
  onFileEdited?: (event: FileEditedEvent) => void
  onSessionCreated?: (event: SessionCreatedEvent) => void
  onSessionUpdated?: (event: SessionUpdatedEvent) => void
  onExternalMessage?: (event: ExternalMessageEvent) => void
  onSessionStatus?: (event: SessionStatusEvent) => void
  onSessionBusy?: (event: SessionBusyEvent) => void
  onSessionIdle?: (event: SessionIdleEvent) => void
  onChildSessionEvent?: (event: OpenCodeSSEEvent) => void
  onError?: (event: ErrorEvent) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onInactivityWarning?: (active: boolean) => void
}

// OpenCode SSE event structure
export interface OpenCodeSSEEvent {
  type: string
  properties: Record<string, unknown>
}

// Module-level tracked child session IDs.
// When a child session (subagent) is detected, its ID is added here so the SSE
// filter lets its events through and routes them to onChildSessionEvent.
const childSessionIds = new Set<string>()

export function registerChildSession(id: string): void {
  childSessionIds.add(id)
}

export function unregisterChildSession(id: string): void {
  childSessionIds.delete(id)
}

export function clearAllChildSessions(): void {
  childSessionIds.clear()
}

export function isChildSession(id: string): boolean {
  return childSessionIds.has(id)
}

export class OpenCodeSSE {
  private eventSource: EventSource | null = null
  private baseUrl: string
  private sessionId: string
  private workspacePath?: string
  private handlers: SSEHandlers
  private reconnectAttempts = 0
  private maxReconnectAttempts = 15
  private reconnectDelay = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private hasNotifiedConnected = false
  // Track which messages we've already created to avoid duplicates
  private createdMessageIds = new Set<string>()
  // Track part types (partID → "text" | "reasoning" | ...) for routing deltas
  private partTypeMap = new Map<string, string>()
  // Track last event time for inactivity detection
  private lastEventTime = 0
  private inactivityTimer: ReturnType<typeof setInterval> | null = null
  private inactivityWarningActive = false
  private static readonly INACTIVITY_CHECK_INTERVAL = 10000 // Check every 10s
  private static readonly INACTIVITY_THRESHOLD = 30000 // Warn after 30s of no events

  constructor(baseUrl: string, sessionId: string | null, handlers: SSEHandlers, workspacePath?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.sessionId = sessionId ?? ''
    this.workspacePath = workspacePath
    this.handlers = handlers
  }

  // Update the session filter without reconnecting the SSE stream
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId
  }

  connect(): void {
    if (this.eventSource) {
      this.disconnect()
    }

    // Clear any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // OpenCode uses /event endpoint for SSE
    // EventSource doesn't support custom headers, so we pass directory via query parameter
    const url = new URL(`${this.baseUrl}/event`)
    if (this.workspacePath) {
      url.searchParams.set('directory', this.workspacePath)
    }
    this.eventSource = new EventSource(url.toString())

    this.eventSource.onopen = () => {
      console.log('[SSE] Connected to OpenCode')
      this.reconnectAttempts = 0
      // Clear any pending reconnect timer since we're connected
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      this.hasNotifiedConnected = true
      this.lastEventTime = Date.now()
      this.startInactivityMonitor()
      this.handlers.onConnected?.()
    }

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as OpenCodeSSEEvent
        this.lastEventTime = Date.now()
        this.clearInactivityWarning()
        this.handleEvent(data)
        // If we're receiving messages but haven't notified connected yet
        // (e.g., onopen was missed during auto-reconnect), ensure state is in sync
        if (!this.hasNotifiedConnected) {
          this.hasNotifiedConnected = true
          this.handlers.onConnected?.()
        }
      } catch (error) {
        console.error('[SSE] Failed to parse event:', error)
      }
    }

    this.eventSource.onerror = (error) => {
      console.error('[SSE] Connection error:', error)

      // Only treat as truly disconnected if EventSource has given up (CLOSED state).
      // When readyState is CONNECTING, EventSource is auto-reconnecting - don't interfere.
      if (this.eventSource?.readyState === EventSource.CLOSED) {
        this.hasNotifiedConnected = false
        this.handlers.onDisconnected?.()

        // Manual reconnect only when EventSource has given up
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++
          console.log(`[SSE] EventSource closed, manual reconnect (attempt ${this.reconnectAttempts})`)
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this.connect()
          }, this.reconnectDelay * this.reconnectAttempts)
        }
      } else {
        console.log('[SSE] Transient error, EventSource auto-reconnecting...')
      }
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopInactivityMonitor()
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
      this.createdMessageIds.clear()
      this.partTypeMap.clear()
      console.log('[SSE] Disconnected from OpenCode')
    }
  }

  // Event types that should bypass session ID filtering (global events)
  private static readonly GLOBAL_EVENT_TYPES = new Set([
    'session.created',
    'session.updated',
    'session.deleted',
    'session.status',
    'session.idle',
    'session.error',
    'server.connected',
    'error',
    'permission.asked',
    'permission.replied',
  ])

  private handleEvent(event: OpenCodeSSEEvent): void {
    const { type, properties } = event
    
    // Global events bypass session ID filtering;
    // message/tool events are filtered to the active session only
    if (!OpenCodeSSE.GLOBAL_EVENT_TYPES.has(type)) {
      const eventSessionId = this.getSessionIdFromProperties(properties)
      if (eventSessionId && eventSessionId !== this.sessionId) {
        if (childSessionIds.has(eventSessionId)) {
          this.handleChildSessionEvent(event)
          return
        }
        // Log filtered events for debugging streaming interruptions
        if (type.startsWith('message.')) {
          console.log('[SSE] Filtered (session mismatch):', {
            type,
            eventSessionId,
            expectedSessionId: this.sessionId,
            isChildSession: childSessionIds.has(eventSessionId),
          })
        }
        return // Ignore message/tool events for other sessions
      }
    }

    console.log('[SSE] Event:', type, properties)

    switch (type) {
      case 'server.connected':
        console.log('[SSE] Server connected')
        break

      case 'message.updated': {
        const info = properties.info as {
          id: string
          sessionID: string
          role: 'user' | 'assistant'
          time: { created: number; completed?: number }
          cost?: number
          tokens?: {
            input: number
            output: number
            reasoning: number
            cache: { read: number; write: number }
          }
        }
        
        if (info.role === 'user') {
          // User message received via SSE — this is an external message
          // (e.g., sent via Feishu gateway, not from the current app).
          // When the app sends a message, it adds an optimistic temp-user-* message
          // and doesn't rely on SSE for user messages. So any user message arriving
          // via SSE is from an external source → trigger a full message reload.
          this.handlers.onExternalMessage?.({
            sessionId: info.sessionID,
            messageId: info.id,
            role: 'user',
          })
        } else if (info.role === 'assistant') {
          if (!info.time.completed && !this.createdMessageIds.has(info.id)) {
            // New assistant message started (only create once)
            // Note: During retry, OpenCode may re-send message.updated for the same message.
            // We rely on createdMessageIds to prevent duplicates, but this is unreliable
            // because message.completed clears the ID. The frontend's handleMessageCreated
            // has a secondary check (messageExists) to prevent creating duplicate messages.
            console.log('[SSE] message.updated (new):', {
              messageId: info.id,
              sessionId: info.sessionID,
              completed: info.time.completed,
              hasTrackedBefore: this.createdMessageIds.has(info.id),
            })
            this.createdMessageIds.add(info.id)
            this.handlers.onMessageCreated?.({
              id: info.id,
              sessionId: info.sessionID,
              role: info.role,
              createdAt: new Date(info.time.created).toISOString(),
            })
          } else if (info.time.completed) {
            // Message completed - clean up tracking
            console.log('[SSE] message.updated (completed):', {
              messageId: info.id,
              sessionId: info.sessionID,
            })
            this.createdMessageIds.delete(info.id)
            this.handlers.onMessageCompleted?.({
              messageId: info.id,
              sessionId: info.sessionID,
              finalContent: '',
              usage: info.tokens
                ? {
                    inputTokens: info.tokens.input,
                    outputTokens: info.tokens.output,
                  }
                : { inputTokens: 0, outputTokens: 0 },
              tokens: info.tokens,
              cost: info.cost,
            })
          } else {
            // Message already tracked and not completed - ignore (ongoing streaming)
            console.log('[SSE] message.updated (already tracked):', info.id)
          }
        }
        break
      }

      case 'message.completed': {
        const completedData = properties as {
          messageId?: string
          messageID?: string
          sessionId?: string
          sessionID?: string
          finalContent?: string
          content?: string
          tokens?: {
            input: number
            output: number
            reasoning: number
            cache: { read: number; write: number }
          }
          cost?: number
        }
        const messageId = completedData.messageId || completedData.messageID
        const sessionId = completedData.sessionId || completedData.sessionID
        
        if (messageId && sessionId) {
          console.log('[SSE] message.completed event:', {
            messageId,
            sessionId,
            hasContent: !!(completedData.finalContent || completedData.content),
            contentLength: (completedData.finalContent || completedData.content || '').length,
          })
          this.handlers.onMessageCompleted?.({
            messageId,
            sessionId,
            finalContent: completedData.finalContent || completedData.content || '',
            usage: completedData.tokens
              ? {
                  inputTokens: completedData.tokens.input,
                  outputTokens: completedData.tokens.output,
                }
              : { inputTokens: 0, outputTokens: 0 },
            tokens: completedData.tokens,
            cost: completedData.cost,
          })
        } else {
          console.warn('[SSE] message.completed with invalid data:', completedData)
        }
        break
      }

      case 'message.part.delta': {
        // Real-time incremental streaming from OpenCode
        // Note: field is always "text" (the property name being updated),
        // so we use partTypeMap to distinguish text vs reasoning parts.
        const deltaProps = properties as {
          sessionID: string
          messageID: string
          partID: string
          field: string
          delta: string
        }
        if (deltaProps.delta) {
          const partType = this.partTypeMap.get(deltaProps.partID) || 'text'
          console.log('[SSE] message.part.delta:', {
            messageId: deltaProps.messageID,
            partId: deltaProps.partID,
            partType,
            deltaLength: deltaProps.delta.length,
            sessionId: deltaProps.sessionID,
          })
          if (partType === 'reasoning') {
            this.handlers.onMessagePartUpdated?.({
              messageId: deltaProps.messageID,
              partId: deltaProps.partID,
              type: 'reasoning_delta',
              delta: deltaProps.delta,
            })
          } else {
            this.handlers.onMessagePartUpdated?.({
              messageId: deltaProps.messageID,
              partId: deltaProps.partID,
              type: 'text_delta',
              delta: deltaProps.delta,
            })
          }
        }
        break
      }

      case 'message.part.updated': {
        const part = properties.part as {
          id: string
          sessionID: string
          messageID: string
          type: string
          text?: string
          tool?: string
          callID?: string
          state?: { status: string; input: Record<string, unknown>; raw?: string }
          time?: { start: number; end?: number }
        }

        console.log('[SSE] message.part.updated:', {
          partId: part.id,
          messageId: part.messageID,
          type: part.type,
          hasText: !!part.text,
          textLength: part.text?.length || 0,
          hasEnd: !!part.time?.end,
          tool: part.tool,
        })

        // Record part type so message.part.delta can route correctly
        if (part.type && part.id) {
          this.partTypeMap.set(part.id, part.type)
        }

        if (part.type === 'text' && part.text && part.time?.end) {
          // Final text snapshot (part completed) — only emit if we haven't been
          // receiving deltas, to avoid overwriting streamed content with a duplicate
          this.handlers.onMessagePartCreated?.({
            messageId: part.messageID,
            partId: part.id,
            type: 'text',
            content: part.text,
          })
        } else if (part.type === 'reasoning' && part.text && part.time?.end) {
          // Final reasoning snapshot (part completed)
          this.handlers.onMessagePartCreated?.({
            messageId: part.messageID,
            partId: part.id,
            type: 'reasoning',
            text: part.text,
          })
        } else if (part.type === 'step-start' || part.type === 'step-finish') {
          // Step markers
          this.handlers.onMessagePartCreated?.({
            messageId: part.messageID,
            partId: part.id,
            type: part.type as 'step-start' | 'step-finish',
          })
        } else if (part.type === 'tool' || part.type === 'tool-call') {
          // Tool call event
          const status = part.state?.status
          const state = part.state as Record<string, unknown> | undefined
          const rawResult = state?.raw || state?.output || state?.result
          const result = typeof rawResult === 'string' ? rawResult : rawResult ? JSON.stringify(rawResult) : undefined
          const duration = (part.time?.end && part.time?.start) 
            ? part.time.end - part.time.start 
            : undefined
          const hasEnded = !!part.time?.end

          // Determine tool status: explicit status takes priority, then use time.end as fallback
          let mappedStatus: 'completed' | 'failed' | 'running' = 'running'
          if (status === 'completed' || status === 'done' || status === 'success') {
            mappedStatus = 'completed'
          } else if (status === 'error' || status === 'failed') {
            mappedStatus = 'failed'
          } else if (hasEnded) {
            mappedStatus = 'completed'
          }
          
          if (mappedStatus === 'completed') {
            console.log('[SSE] Tool completed:', part.tool, 'state:', state)
          }
          
          const metadata = state?.metadata as ToolExecutingEvent['metadata'] | undefined
          
          this.handlers.onToolExecuting?.({
            toolCallId: part.callID || part.id,
            toolName: part.tool || 'unknown',
            status: mappedStatus,
            arguments: part.state?.input || {},
            result,
            duration,
            metadata,
            sessionId: part.sessionID,
            messageId: part.messageID,
          })
        }
        break
      }

      case 'session.status': {
        const statusData = properties as {
          sessionID?: string
          status?: { type: string; attempt?: number; message?: string; next?: number }
        }
        const statusSessionId = statusData.sessionID || (properties.sessionId as string | undefined)
        const status = statusData.status
        if (!statusSessionId || !status) break
        console.log('[SSE] session.status RAW:', JSON.stringify({ sessionID: statusSessionId, status }))

        let statusInfo: import('./sse').SessionStatusInfo
        if (status.type === 'retry') {
          statusInfo = {
            type: 'retry',
            attempt: status.attempt ?? 1,
            message: status.message ?? 'Request failed, retrying...',
            next: status.next ?? Date.now() + 5000,
          }
        } else if (status.type === 'busy') {
          statusInfo = { type: 'busy' }
        } else {
          statusInfo = { type: 'idle' }
        }

        this.handlers.onSessionStatus?.({ sessionId: statusSessionId, status: statusInfo })

        // Legacy handlers
        if (status.type === 'busy') {
          this.handlers.onSessionBusy?.({ sessionId: statusSessionId })
        }
        break
      }

      case 'session.idle': {
        const idleSessionId = (properties as { sessionID?: string }).sessionID
          || (properties.sessionId as string | undefined)
        console.log('[SSE] Session idle, session:', idleSessionId)

        if (idleSessionId) {
          this.handlers.onSessionStatus?.({ sessionId: idleSessionId, status: { type: 'idle' } })
          this.handlers.onSessionIdle?.({ sessionId: idleSessionId })
        }
        break
      }

      case 'session.created': {
        const createdData = properties as {
          sessionID?: string
          info?: { id?: string; directory?: string; parentID?: string }
        }
        const createdSessionId = createdData.sessionID || createdData.info?.id
        const createdDir = createdData.info?.directory || (properties.directory as string | undefined)
        const parentID = createdData.info?.parentID
        
        console.log('[SSE] Session created:', createdSessionId, parentID ? `(child of ${parentID})` : '')
        
        if (createdSessionId) {
          this.handlers.onSessionCreated?.({
            sessionId: createdSessionId,
            directory: createdDir,
            parentID,
          })
        }
        break
      }

      case 'session.updated': {
        const updatedData = properties as {
          sessionID?: string
          info?: { id?: string; directory?: string }
        }
        const updatedSessionId = updatedData.sessionID || updatedData.info?.id
        const updatedDir = updatedData.info?.directory || (properties.directory as string | undefined)
        
        console.log('[SSE] Session updated:', updatedSessionId)
        
        if (updatedSessionId) {
          this.handlers.onSessionUpdated?.({
            sessionId: updatedSessionId,
            directory: updatedDir,
          })
        }
        break
      }

      case 'error': {
        const error = properties as { code?: string; message?: string }
        this.handlers.onError?.({
          code: error.code || 'unknown',
          message: error.message || 'Unknown error',
        })
        break
      }

      case 'question.asked': {
        const questionData = properties as {
          id: string
          sessionID: string
          questions: Array<{
            id?: string
            question: string
            header?: string
            options: Array<{ id?: string; label: string; value?: string }>
          }>
          tool?: {
            callID: string
            messageID: string
          }
        }
        
        console.log('[SSE] Question asked:', questionData.id)
        
        this.handlers.onQuestionAsked?.({
          id: questionData.id,
          sessionId: questionData.sessionID,
          questions: questionData.questions,
          tool: questionData.tool ? {
            callId: questionData.tool.callID,
            messageId: questionData.tool.messageID,
          } : undefined,
        })
        break
      }

      case 'question.answered': {
        console.log('[SSE] Question answered')
        // Question has been answered - the tool status will be updated via message.part.updated
        break
      }

      case 'todo.updated': {
        const todoData = properties as {
          sessionID: string
          todos: Array<{
            id: string
            content: string
            status: string
            priority: string
          }>
        }
        
        console.log('[SSE] Todo updated:', todoData.todos?.length || 0, 'items')
        
        this.handlers.onTodoUpdated?.({
          sessionId: todoData.sessionID,
          todos: todoData.todos.map(t => ({
            id: t.id,
            content: t.content,
            status: t.status as 'pending' | 'in_progress' | 'completed' | 'cancelled',
            priority: t.priority as 'high' | 'medium' | 'low',
          })),
        })
        break
      }

      case 'session.diff': {
        const diffData = properties as {
          sessionID: string
          diff: Array<{
            file: string
            before: string
            after: string
            additions: number
            deletions: number
          }>
        }
        
        console.log('[SSE] Session diff:', diffData.diff?.length || 0, 'files')
        
        this.handlers.onSessionDiff?.({
          sessionId: diffData.sessionID,
          diff: diffData.diff || [],
        })
        break
      }

      case 'file.edited': {
        const fileData = properties as { file: string }
        console.log('[SSE] File edited:', fileData.file)
        this.handlers.onFileEdited?.({ file: fileData.file })
        break
      }

      case 'permission.asked': {
        const permData = properties as {
          id: string
          sessionID: string
          permission: string
          patterns?: string[]
          always?: string[]
          metadata?: Record<string, unknown>
          tool?: { callID: string; messageID: string }
        }
        
        console.log('[SSE] Permission asked:', permData.permission, permData.id, permData.patterns, 'always:', permData.always)
        
        this.handlers.onPermissionAsked?.({
          id: permData.id,
          sessionID: permData.sessionID,
          permission: permData.permission || 'write',
          patterns: permData.patterns || [],
          always: permData.always,
          metadata: permData.metadata,
          tool: permData.tool,
        })
        break
      }

      case 'permission.replied': {
        console.log('[SSE] Permission replied')
        break
      }

      case 'session.error': {
        console.log('[SSE] Session error RAW:', JSON.stringify(properties))
        const errorData = properties as {
          sessionID?: string
          error?: {
            name: string
            message?: string
            data?: {
              message?: string
              providerID?: string
              statusCode?: number
              isRetryable?: boolean
            }
          }
        }

        // Normalize error structure: some versions of OpenCode put message
        // directly on error.message instead of error.data.message
        const rawError = errorData.error
        let normalizedError: SessionErrorEvent['error'] | undefined
        if (rawError) {
          const msg = rawError.data?.message || rawError.message || ''
          normalizedError = {
            name: rawError.name,
            data: {
              message: msg,
              providerID: rawError.data?.providerID,
              statusCode: rawError.data?.statusCode,
              isRetryable: rawError.data?.isRetryable,
            },
          }
        }

        console.log('[SSE] Session error normalized message:', normalizedError?.data?.message)
        
        this.handlers.onSessionError?.({
          sessionId: errorData.sessionID,
          error: normalizedError,
        })
        break
      }

      default:
        console.log('[SSE] Unhandled event type:', type)
    }
  }

  private handleChildSessionEvent(event: OpenCodeSSEEvent): void {
    const { type, properties } = event

    // For message.part.updated, record part types so deltas can be routed
    if (type === 'message.part.updated') {
      const part = properties.part as { id?: string; type?: string } | undefined
      if (part?.type && part?.id) {
        this.partTypeMap.set(part.id, part.type)
      }
    }

    this.handlers.onChildSessionEvent?.(event)
  }

  private getSessionIdFromProperties(properties: Record<string, unknown>): string | null {
    // Try to extract session ID from various property structures
    if (properties.sessionID) return properties.sessionID as string
    if (properties.info && typeof properties.info === 'object') {
      const info = properties.info as Record<string, unknown>
      if (info.sessionID) return info.sessionID as string
    }
    if (properties.part && typeof properties.part === 'object') {
      const part = properties.part as Record<string, unknown>
      if (part.sessionID) return part.sessionID as string
    }
    return null
  }

  get isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN
  }

  private startInactivityMonitor(): void {
    this.stopInactivityMonitor()
    this.inactivityTimer = setInterval(() => {
      if (this.lastEventTime === 0) return
      const elapsed = Date.now() - this.lastEventTime
      if (elapsed >= OpenCodeSSE.INACTIVITY_THRESHOLD && !this.inactivityWarningActive) {
        this.inactivityWarningActive = true
        console.log(`[SSE] No events for ${Math.round(elapsed / 1000)}s, task may still be running...`)
        this.handlers.onInactivityWarning?.(true)
      }
    }, OpenCodeSSE.INACTIVITY_CHECK_INTERVAL)
  }

  private stopInactivityMonitor(): void {
    if (this.inactivityTimer) {
      clearInterval(this.inactivityTimer)
      this.inactivityTimer = null
    }
    this.clearInactivityWarning()
  }

  private clearInactivityWarning(): void {
    if (this.inactivityWarningActive) {
      this.inactivityWarningActive = false
      this.handlers.onInactivityWarning?.(false)
    }
  }
}

// Hook for React components
import { useEffect, useRef, useCallback } from 'react'

export function useOpenCodeSSE(
  baseUrl: string,
  sessionId: string | null,
  handlers: SSEHandlers,
  workspacePath?: string | null
) {
  const sseRef = useRef<OpenCodeSSE | null>(null)
  const handlersRef = useRef(handlers)
  const sessionIdRef = useRef(sessionId)

  // Update handlers ref when handlers change
  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  // Update session filter without reconnecting SSE.
  // The SSE stream is global (/event), sessionId only controls per-session event filtering.
  // Global events (session.created, session.updated, etc.) always flow regardless of sessionId.
  useEffect(() => {
    sessionIdRef.current = sessionId
    if (sseRef.current) {
      sseRef.current.setSessionId(sessionId ?? '')
    }
  }, [sessionId])

  const connect = useCallback(() => {
    // Connect SSE as soon as baseUrl is available.
    // sessionId is NOT required — the /event endpoint is global.
    // Without a sessionId, global events (session.created/updated/deleted) still flow,
    // while per-session events (message.*, tool.*) are simply filtered out.
    if (!baseUrl) return

    // Create SSE instance with current handlers and workspace path.
    // Use sessionIdRef to avoid re-creating the connection when sessionId changes.
    // Session filter updates are handled by setSessionId() above.
    sseRef.current = new OpenCodeSSE(baseUrl, sessionIdRef.current, {
      onMessageCreated: (e) => handlersRef.current.onMessageCreated?.(e),
      onMessagePartCreated: (e) => handlersRef.current.onMessagePartCreated?.(e),
      onMessagePartUpdated: (e) => handlersRef.current.onMessagePartUpdated?.(e),
      onMessageCompleted: (e) => handlersRef.current.onMessageCompleted?.(e),
      onToolExecuting: (e) => handlersRef.current.onToolExecuting?.(e),
      onPermissionAsked: (e) => handlersRef.current.onPermissionAsked?.(e),
      onQuestionAsked: (e) => handlersRef.current.onQuestionAsked?.(e),
      onTodoUpdated: (e) => handlersRef.current.onTodoUpdated?.(e),
      onSessionDiff: (e) => handlersRef.current.onSessionDiff?.(e),
      onSessionError: (e) => handlersRef.current.onSessionError?.(e),
      onFileEdited: (e) => handlersRef.current.onFileEdited?.(e),
      onSessionCreated: (e) => handlersRef.current.onSessionCreated?.(e),
      onSessionUpdated: (e) => handlersRef.current.onSessionUpdated?.(e),
      onExternalMessage: (e) => handlersRef.current.onExternalMessage?.(e),
      onSessionStatus: (e) => handlersRef.current.onSessionStatus?.(e),
      onSessionBusy: (e) => handlersRef.current.onSessionBusy?.(e),
      onSessionIdle: (e) => handlersRef.current.onSessionIdle?.(e),
      onError: (e) => handlersRef.current.onError?.(e),
      onConnected: () => handlersRef.current.onConnected?.(),
      onDisconnected: () => handlersRef.current.onDisconnected?.(),
      onChildSessionEvent: (e) => handlersRef.current.onChildSessionEvent?.(e),
      onInactivityWarning: (active) => handlersRef.current.onInactivityWarning?.(active),
    }, workspacePath || undefined)

    sseRef.current.connect()
  }, [baseUrl]) // Only baseUrl — sessionId changes are handled by setSessionId()

  const disconnect = useCallback(() => {
    sseRef.current?.disconnect()
    sseRef.current = null
  }, [])

  // Connect SSE once when baseUrl is available.
  // SSE connection is NOT gated on sessionId — the /event endpoint streams all events.
  // Global events (session.created/updated) must be received even without an active session.
  // Don't reconnect when sessionId changes — just update the filter (handled above).
  useEffect(() => {
    if (baseUrl) {
      connect()
    }
    return () => {
      disconnect()
    }
  }, [baseUrl, connect, disconnect])

  return {
    connect,
    disconnect,
    isConnected: sseRef.current?.isConnected ?? false,
  }
}
