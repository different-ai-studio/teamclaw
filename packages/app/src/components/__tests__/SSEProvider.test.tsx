import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

const mockUseOpenCodeSSE = vi.fn()

vi.mock('@/lib/opencode/sse', () => ({
  useOpenCodeSSE: (...args: unknown[]) => mockUseOpenCodeSSE(...args),
}))

let mockActiveSessionId: string | null = null
let mockWorkspacePath: string | null = null
let mockOpenCodeUrl: string | null = null

const mockStoreState = {
  handleMessageCreated: vi.fn(),
  handleMessagePartCreated: vi.fn(),
  handleMessagePartUpdated: vi.fn(),
  handleMessageCompleted: vi.fn(),
  handleToolExecuting: vi.fn(),
  handlePermissionAsked: vi.fn(),
  handleQuestionAsked: vi.fn(),
  handleTodoUpdated: vi.fn(),
  handleSessionDiff: vi.fn(),
  handleFileEdited: vi.fn(),
  handleSessionError: vi.fn(),
  handleSessionCreated: vi.fn(),
  handleSessionUpdated: vi.fn(),
  handleExternalMessage: vi.fn(),
  handleSessionStatus: vi.fn(),
  handleSessionBusy: vi.fn(),
  handleSessionIdle: vi.fn(),
  handleChildSessionEvent: vi.fn(),
  setConnected: vi.fn(),
  setError: vi.fn(),
  setInactivityWarning: vi.fn(),
}

vi.mock('@/stores/session', () => ({
  useSessionStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ activeSessionId: mockActiveSessionId }),
    {
      getState: () => mockStoreState,
    },
  ),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({
      workspacePath: mockWorkspacePath,
      openCodeUrl: mockOpenCodeUrl,
    }),
}))

import { SSEProvider } from '../SSEProvider'

describe('SSEProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockActiveSessionId = null
    mockWorkspacePath = '/test/workspace'
    mockOpenCodeUrl = 'http://localhost:13141'
  })

  it('calls useOpenCodeSSE on mount', () => {
    render(<SSEProvider />)
    expect(mockUseOpenCodeSSE).toHaveBeenCalled()
  })

  it('passes openCodeUrl as first argument and activeSessionId as second argument', () => {
    mockActiveSessionId = 'active-session-123'
    mockOpenCodeUrl = 'http://localhost:13141'

    render(<SSEProvider />)

    expect(mockUseOpenCodeSSE).toHaveBeenCalledWith(
      'http://localhost:13141',
      'active-session-123',
      expect.any(Object),
      expect.anything(),
    )
  })

  it('unmounts cleanly without throwing', () => {
    const { unmount } = render(<SSEProvider />)
    expect(() => unmount()).not.toThrow()
  })
})
