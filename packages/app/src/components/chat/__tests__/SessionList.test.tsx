import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

const mockSetActiveSession = vi.fn()
const mockClearSelection = vi.fn()
const mockSetFileModeRightTab = vi.fn()

// Mutable state refs for stores
let mockSessions: Array<{ id: string; title: string; updatedAt: string | Date; messageCount?: number }> = []
let mockActiveSessionId: string | null = null
let mockIsLoading = false
let mockHighlightedSessionIds: string[] = []
let mockLayoutMode = 'task'

vi.mock('@/stores/session', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) =>
    selector({
      sessions: mockSessions,
      activeSessionId: mockActiveSessionId,
      isLoading: mockIsLoading,
      highlightedSessionIds: mockHighlightedSessionIds,
      setActiveSession: mockSetActiveSession,
    }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ clearSelection: mockClearSelection }),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (s: unknown) => unknown) =>
    selector({ layoutMode: mockLayoutMode, setFileModeRightTab: mockSetFileModeRightTab }),
}))

// Mock date-format
vi.mock('@/lib/date-format', () => ({
  formatRelativeDate: () => 'just now',
}))

// Mock tanstack virtual
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 0,
    getVirtualItems: () => [],
  }),
}))

// Must be imported after mocks
import { SessionList } from '../SessionList'

// Need static getState for the handleSelectSession callback
vi.mock('@/stores/session', () => ({
  useSessionStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        sessions: mockSessions,
        activeSessionId: mockActiveSessionId,
        isLoading: mockIsLoading,
        highlightedSessionIds: mockHighlightedSessionIds,
        setActiveSession: mockSetActiveSession,
      }),
    {
      getState: () => ({
        activeSessionId: mockActiveSessionId,
        setActiveSession: mockSetActiveSession,
      }),
    },
  ),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ layoutMode: mockLayoutMode, setFileModeRightTab: mockSetFileModeRightTab }),
    {
      getState: () => ({ layoutMode: mockLayoutMode }),
    },
  ),
}))

describe('SessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessions = []
    mockActiveSessionId = null
    mockIsLoading = false
    mockHighlightedSessionIds = []
    mockLayoutMode = 'task'
  })

  it('renders a list of sessions', () => {
    mockSessions = [
      { id: 'sess-1', title: 'First Session', updatedAt: new Date().toISOString() },
      { id: 'sess-2', title: 'Second Session', updatedAt: new Date().toISOString() },
    ]
    render(<SessionList />)
    expect(screen.getByText('First Session')).toBeTruthy()
    expect(screen.getByText('Second Session')).toBeTruthy()
  })

  it('clicking a session triggers setActiveSession', () => {
    mockSessions = [
      { id: 'sess-1', title: 'Click Me', updatedAt: new Date().toISOString() },
    ]
    render(<SessionList />)
    fireEvent.click(screen.getByText('Click Me'))
    expect(mockSetActiveSession).toHaveBeenCalledWith('sess-1')
  })

  it('shows empty state when there are no sessions', () => {
    mockSessions = []
    render(<SessionList />)
    expect(screen.getByText('No conversations yet')).toBeTruthy()
  })
})
