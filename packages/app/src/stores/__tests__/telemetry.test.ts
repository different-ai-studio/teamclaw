import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  mockIsTauri,
  mockInvoke,
  mockLoadAllSessionMessages,
} = vi.hoisted(() => ({
  mockIsTauri: vi.fn(() => false),
  mockInvoke: vi.fn(),
  mockLoadAllSessionMessages: vi.fn(async () => undefined),
}))

vi.mock('@/lib/utils', () => ({ isTauri: mockIsTauri }))
vi.mock('@/lib/telemetry/scoring-engine', () => ({
  ScoringEngine: vi.fn().mockImplementation(() => ({ score: vi.fn(async () => []) })),
}))
vi.mock('@/lib/telemetry/report-builder', () => ({
  buildSessionReport: vi.fn(() => null),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: Object.assign(
    vi.fn(() => ({})),
    {
      getState: () => ({
        sessions: [],
        getSessionMessages: () => [],
        loadAllSessionMessages: mockLoadAllSessionMessages,
      }),
    },
  ),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/tmp/teamclaw-test-workspace' }),
  },
}))
vi.mock('@/lib/opencode/sdk-client', () => ({
  getOpenCodeClient: vi.fn(() => ({ getMessages: vi.fn(async () => []) })),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))

// Import after mocks
const { useTelemetryStore } = await import('@/stores/telemetry')

describe('telemetryStore', () => {
  beforeEach(() => {
    vi.useRealTimers()
    mockIsTauri.mockReturnValue(false)
    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue('undecided')
    mockLoadAllSessionMessages.mockClear()
    useTelemetryStore.setState({
      consent: 'undecided',
      deviceId: null,
      isInitialized: false,
      feedbackCache: new Map(),
      starRatingCache: new Map(),
      isGeneratingReports: false,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initializes with default state', () => {
    const state = useTelemetryStore.getState()
    expect(state.consent).toBe('undecided')
    expect(state.isInitialized).toBe(false)
  })

  it('init sets isInitialized to true in non-tauri env', async () => {
    await useTelemetryStore.getState().init()
    expect(useTelemetryStore.getState().isInitialized).toBe(true)
  })

  it('does not auto-generate reports during init when consent is already granted', async () => {
    vi.useFakeTimers()
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'telemetry_get_consent') return 'granted'
      return undefined
    })

    await useTelemetryStore.getState().init()
    await vi.advanceTimersByTimeAsync(5000)

    expect(useTelemetryStore.getState().consent).toBe('granted')
    expect(mockLoadAllSessionMessages).not.toHaveBeenCalled()
  })

  it('getFeedback returns undefined for unknown message', () => {
    const result = useTelemetryStore.getState().getFeedback('unknown-id')
    expect(result).toBeUndefined()
  })
})
