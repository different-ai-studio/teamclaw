import type {
  OpenCodeConfig,
  Session,
  SessionListItem,
  Message,
  SendMessageRequest,
  PermissionReplyRequest,
  PermissionAskedEvent,
  Project,
  Command,
  MCPStatusMap,
  MCPServerConfig,
} from './types'

// Re-export Command type for convenience
export type { Command }

export class OpenCodeClient {
  private baseUrl: string
  private password?: string
  private workspacePath?: string

  constructor(config: OpenCodeConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.password = config.password
    this.workspacePath = config.workspacePath
  }

  // Update workspace path
  setWorkspacePath(workspacePath: string | null | undefined): void {
    this.workspacePath = workspacePath || undefined
  }

  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }
    if (this.password) {
      headers['Authorization'] = `Bearer ${this.password}`
    }
    // Add workspace directory header for OpenCode server
    if (this.workspacePath) {
      headers['x-opencode-directory'] = this.workspacePath
    }
    return headers
  }

  private buildUrl(path: string): string {
    const url = new URL(path, this.baseUrl)
    // Add directory query parameter if workspace path is set
    if (this.workspacePath) {
      url.searchParams.set('directory', this.workspacePath)
    }
    return url.toString()
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = this.buildUrl(path)
    
    // Debug: Log request body for message endpoints
    if (body && path.includes('/message') && method === 'POST') {
      console.log('[OpenCode] Request body:', JSON.stringify(body, null, 2));
    }
    
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: this.getHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch {
      throw new Error(`Cannot connect to OpenCode server (${this.baseUrl}). Please make sure OpenCode server is running.`)
    }

    // Check if response is JSON
    const contentType = response.headers.get('content-type')
    if (!contentType?.includes('application/json')) {
      throw new Error(`OpenCode server is not running or returned non-JSON response.`)
    }

    const data = await response.json()
    
    // OpenCode returns { success: false, error: [...] } for errors
    if (data.success === false && data.error) {
      const errorMessage = Array.isArray(data.error) 
        ? data.error.map((e: { message?: string }) => e.message).join(', ')
        : String(data.error)
      throw new Error(`OpenCode API Error: ${errorMessage}`)
    }

    if (!response.ok) {
      throw new Error(`OpenCode API Error: ${response.status}`)
    }

    return data
  }

  // Session APIs
  async createSession(): Promise<Session> {
    return this.request<Session>('POST', '/session', {})
  }

  async listSessions(options?: { directory?: string; roots?: boolean }): Promise<SessionListItem[]> {
    // OpenCode API supports: directory (filter by path), roots (exclude child sessions)
    // Note: API returns sessions in undefined order (no ORDER BY), client must sort
    const params = new URLSearchParams()
    if (options?.directory) {
      params.set('directory', options.directory)
    }
    if (options?.roots) {
      params.set('roots', 'true')
    }
    const queryString = params.toString()
    const endpoint = queryString ? `/session?${queryString}` : '/session'
    return this.request<SessionListItem[]>('GET', endpoint)
  }

  async getSession(id: string): Promise<Session> {
    return this.request<Session>('GET', `/session/${id}`)
  }

  async deleteSession(id: string): Promise<void> {
    await this.request<void>('DELETE', `/session/${id}`)
  }

  async archiveSession(id: string, directory?: string): Promise<void> {
    // Use PATCH /session/:id with time.archived field (official OpenCode API)
    const params = new URLSearchParams()
    if (directory) {
      params.set('directory', directory)
    }
    const queryString = params.toString()
    const endpoint = queryString ? `/session/${id}?${queryString}` : `/session/${id}`
    
    const url = `${this.baseUrl}${endpoint}`
    const response = await fetch(url, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify({
        time: {
          archived: Date.now()
        }
      }),
    })

    if (!response.ok) {
      // Try to parse error response
      const contentType = response.headers.get('content-type')
      if (contentType?.includes('application/json')) {
        const data = await response.json()
        if (data.success === false && data.error) {
          const errorMessage = Array.isArray(data.error) 
            ? data.error.map((e: { message?: string }) => e.message).join(', ')
            : String(data.error)
          throw new Error(`OpenCode API Error: ${errorMessage}`)
        }
      }
      throw new Error(`OpenCode API Error: ${response.status}`)
    }

    // PATCH may return 204 No Content or updated Session object
    // Both are valid - if 204, there's no body to parse
    if (response.status === 204) {
      return
    }

    // If there's a response body, parse it (but we don't need to return it)
    const contentType = response.headers.get('content-type')
    if (contentType?.includes('application/json')) {
      await response.json()
    }
  }

  async updateSession(id: string, updates: { title?: string }): Promise<Session> {
    return this.request<Session>('PATCH', `/session/${id}`, updates)
  }

  async abortSession(id: string): Promise<boolean> {
    // Abort endpoint may return 200/202/204 with empty body in some OpenCode versions.
    // Use a tolerant parser here instead of generic JSON-only request().
    const url = this.buildUrl(`/session/${id}/abort`)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
      })
    } catch {
      throw new Error(`Cannot connect to OpenCode server (${this.baseUrl}). Please make sure OpenCode server is running.`)
    }

    if (!response.ok) {
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        try {
          const data = await response.json()
          if (data?.success === false && data?.error) {
            const errorMessage = Array.isArray(data.error)
              ? data.error.map((e: { message?: string }) => e.message).join(', ')
              : String(data.error)
            throw new Error(`OpenCode API Error: ${errorMessage}`)
          }
        } catch {
          // Fall through to generic status error below.
        }
      }
      throw new Error(`OpenCode API Error: ${response.status}`)
    }

    // 204/empty body is considered success for abort.
    return true
  }

  // Message APIs
  async sendMessage(
    sessionId: string, 
    content: string, 
    model?: { providerID: string; modelID: string },
    agent?: string,  // Agent name: 'plan' for planning, 'build' for implementation
    systemPrompt?: string  // System prompt to guide AI behavior
  ): Promise<Message> {
    // Try multiple possible field names for system prompt
    // OpenCode might use different field names: systemPrompt, system_prompt, systemMessage, system, etc.
    const trimmedSystemPrompt = systemPrompt?.trim();
    const request: SendMessageRequest & { 
      model?: { providerID: string; modelID: string }
      system_prompt?: string
      systemMessage?: string
      system?: string
    } = {
      parts: [{ type: 'text', text: content }],
      ...(model && { model }),
      ...(agent && { agent }),
      // Try multiple field names - OpenCode might accept any of these
      ...(trimmedSystemPrompt && { 
        systemPrompt: trimmedSystemPrompt,
        system_prompt: trimmedSystemPrompt,
        systemMessage: trimmedSystemPrompt,
        system: trimmedSystemPrompt,
      }),
    }
    
    // Debug: Log system prompt if provided
    if (trimmedSystemPrompt) {
      console.log('[OpenCode] Sending message with system prompt:', {
        sessionId,
        systemPromptLength: trimmedSystemPrompt.length,
        systemPromptPreview: trimmedSystemPrompt.substring(0, 100) + (trimmedSystemPrompt.length > 100 ? '...' : ''),
        requestKeys: Object.keys(request),
        fullRequest: JSON.stringify(request, null, 2),
      });
    }
    
    // Use /message endpoint with model parameter
    return this.request<Message>('POST', `/session/${sessionId}/message`, request)
  }

  // Send message with multiple parts (text and file parts)
  async sendMessageWithParts(
    sessionId: string,
    parts: SendMessageRequest['parts'],
    model?: { providerID: string; modelID: string },
    systemPrompt?: string  // System prompt to guide AI behavior
  ): Promise<Message> {
    const request: SendMessageRequest & { model?: { providerID: string; modelID: string } } = {
      parts,
      ...(model && { model }),
      ...(systemPrompt && systemPrompt.trim() && { systemPrompt: systemPrompt.trim() }),
    }
    return this.request<Message>('POST', `/session/${sessionId}/message`, request)
  }

  // Send message asynchronously (doesn't wait for response, returns immediately)
  async sendMessageAsync(
    sessionId: string, 
    content: string, 
    model?: { providerID: string; modelID: string },
    agent?: string,  // Agent name: 'plan' for planning, 'build' for implementation
    systemPrompt?: string  // System prompt to guide AI behavior
  ): Promise<void> {
    const request: SendMessageRequest & { model?: { providerID: string; modelID: string } } = {
      parts: [{ type: 'text', text: content }],
      ...(model && { model }),
      ...(agent && { agent }),
      ...(systemPrompt && systemPrompt.trim() && { systemPrompt: systemPrompt.trim() }),
    }
    const url = this.buildUrl(`/session/${sessionId}/prompt_async`)
    
    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
    })

    if (!response.ok && response.status !== 204) {
      throw new Error(`Failed to send async message: ${response.status}`)
    }
  }

  // Send message with parts asynchronously
  async sendMessageWithPartsAsync(
    sessionId: string,
    parts: SendMessageRequest['parts'],
    model?: { providerID: string; modelID: string },
    agent?: string,
    systemPrompt?: string,
  ): Promise<void> {
    const request: SendMessageRequest & { model?: { providerID: string; modelID: string } } = {
      parts,
      ...(model && { model }),
      ...(agent && { agent }),
      ...(systemPrompt && systemPrompt.trim() && { systemPrompt: systemPrompt.trim() }),
    }
    const url = this.buildUrl(`/session/${sessionId}/prompt_async`)
    
    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
    })

    if (!response.ok && response.status !== 204) {
      throw new Error(`Failed to send async message with parts: ${response.status}`)
    }
  }

  // Reply to a question request from the AI assistant
  // POST /question/:requestID/reply with { answers: [[...], [...], ...] }
  async replyQuestion(requestID: string, answers: string[][]): Promise<boolean> {
    return this.request<boolean>('POST', `/question/${requestID}/reply`, { answers })
  }

  // Reject a question request from the AI assistant
  // POST /question/:requestID/reject
  async rejectQuestion(requestID: string): Promise<boolean> {
    return this.request<boolean>('POST', `/question/${requestID}/reject`, {})
  }

  // List pending questions
  // GET /question
  async listQuestions(): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/question')
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    return this.request<Message[]>('GET', `/session/${sessionId}/message`)
  }

  // Get todos for a session
  async getTodos(sessionId: string): Promise<Array<{
    id: string
    content: string
    status: string
    priority: string
  }>> {
    return this.request<Array<{
      id: string
      content: string
      status: string
      priority: string
    }>>('GET', `/session/${sessionId}/todo`)
  }

  // Get file diffs for a session
  async getSessionDiff(sessionId: string): Promise<Array<{
    file: string
    before: string
    after: string
    additions: number
    deletions: number
  }>> {
    return this.request<Array<{
      file: string
      before: string
      after: string
      additions: number
      deletions: number
    }>>('GET', `/session/${sessionId}/diff`)
  }

  // Get file status (tracked files with changes)
  async getFileStatus(): Promise<Array<{
    path: string
    added: number
    removed: number
    status: 'added' | 'deleted' | 'modified'
  }>> {
    return this.request<Array<{
      path: string
      added: number
      removed: number
      status: 'added' | 'deleted' | 'modified'
    }>>('GET', '/file/status')
  }

  // Permission APIs
  async listPermissions(): Promise<PermissionAskedEvent[]> {
    return this.request<PermissionAskedEvent[]>('GET', '/permission')
  }

  async replyPermission(
    permissionId: string,
    request: PermissionReplyRequest
  ): Promise<void> {
    await this.request<void>(
      'POST',
      `/permission/${permissionId}/reply`,
      request
    )
  }

  // Provider APIs
  // GET /provider returns { all: ProviderObj[], connected: string[], default: Record<string,string> }
  async getProviders(): Promise<{
    all: Array<{ id: string; name: string; models: Record<string, { id: string; name: string }> }>
    connected: string[]
    default: Record<string, string>
  }> {
    return this.request('GET', '/provider')
  }

  // Config APIs
  async getConfig(): Promise<{ model?: string }> {
    return this.request<{ model?: string }>('GET', '/config')
  }

  async updateConfig(config: { model?: string }): Promise<{ model?: string }> {
    return this.request<{ model?: string }>('PATCH', '/config', config)
  }

  // GET /config/providers returns connected providers with full model details
  async getConfigProviders(): Promise<{
    providers: Array<{ id: string; name: string; models: Record<string, { id: string; name: string }> }>
    default: Record<string, string>
  }> {
    return this.request('GET', '/config/providers')
  }

  // Auth APIs - Set authentication credentials for a provider
  async setAuth(providerId: string, auth: { type: 'api'; key: string } | { type: 'oauth'; refresh: string; access: string; expires: number }): Promise<boolean> {
    return this.request<boolean>('PUT', `/auth/${providerId}`, auth)
  }

  // Delete authentication credentials for a provider
  async deleteAuth(providerId: string): Promise<boolean> {
    return this.request<boolean>('DELETE', `/auth/${providerId}`)
  }

  // Project APIs
  async getProject(): Promise<Project> {
    return this.request<Project>('GET', '/project')
  }

  // File APIs
  async readFile(path: string): Promise<string> {
    const params = new URLSearchParams({ path })
    return this.request<string>('GET', `/file?${params.toString()}`)
  }

  async listDirectory(path: string): Promise<string[]> {
    const params = new URLSearchParams({ path })
    return this.request<string[]>('GET', `/dir?${params.toString()}`)
  }

  // Command APIs
  async listCommands(): Promise<Command[]> {
    return this.request<Command[]>('GET', '/command')
  }

  async executeCommand(
    sessionId: string,
    command: string,
    args?: string[],
    options?: {
      messageID?: string
      agent?: string
      model?: { providerID: string; modelID: string }
    }
  ): Promise<Message> {
    const body: {
      command: string
      arguments?: string[]
      messageID?: string
      agent?: string
      model?: { providerID: string; modelID: string }
    } = {
      command,
      ...(args && args.length > 0 && { arguments: args }),
      ...(options?.messageID && { messageID: options.messageID }),
      ...(options?.agent && { agent: options.agent }),
      ...(options?.model && { model: options.model }),
    }
    return this.request<Message>('POST', `/session/${sessionId}/command`, body)
  }

  // MCP APIs
  async getMCPStatus(): Promise<MCPStatusMap> {
    return this.request<MCPStatusMap>('GET', '/mcp')
  }

  async addMCPServer(name: string, config: MCPServerConfig): Promise<MCPStatusMap> {
    return this.request<MCPStatusMap>('POST', '/mcp', { name, config })
  }

  async connectMCP(name: string): Promise<boolean> {
    return this.request<boolean>('POST', `/mcp/${encodeURIComponent(name)}/connect`)
  }

  async disconnectMCP(name: string): Promise<boolean> {
    return this.request<boolean>('POST', `/mcp/${encodeURIComponent(name)}/disconnect`)
  }

  async getToolIds(): Promise<string[]> {
    return this.request<string[]>('GET', '/experimental/tool/ids')
  }

  // Health check
  async isReady(): Promise<boolean> {
    try {
      await this.request<unknown>('GET', '/session')
      return true
    } catch {
      return false
    }
  }
}

// Default instance
let defaultClient: OpenCodeClient | null = null

export function getOpenCodeClient(): OpenCodeClient {
  if (!defaultClient) {
    throw new Error('OpenCodeClient not initialized. Call initOpenCodeClient() first.')
  }
  return defaultClient
}

export function initOpenCodeClient(config: OpenCodeConfig): OpenCodeClient {
  defaultClient = new OpenCodeClient(config)
  return defaultClient
}

// Update workspace path for the default client
export function updateOpenCodeClientWorkspace(workspacePath: string | null): void {
  if (defaultClient) {
    defaultClient.setWorkspacePath(workspacePath)
  }
}
