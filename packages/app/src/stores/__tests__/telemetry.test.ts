import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/utils', () => ({ isTauri: () => false }))
vi.mock('@/lib/telemetry/scoring-engine', () => ({
  ScoringEngine: vi.fn().mockImplementation(() => ({ score: vi.fn(async () => []) })),
}))
vi.mock('@/lib/telemetry/report-builder', () => ({
  buildSessionReport: vi.fn(() => null),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: Object.assign(
    vi.fn(() => ({})),
    { getState: () => ({ sessions: [], getSessionMessages: () => [] }) },
  ),
}))
vi.mock('@/lib/opencode/client', () => ({
  getOpenCodeClient: vi.fn(() => ({ getMessages: vi.fn(async () => []) })),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// Import after mocks
const { useTelemetryStore } = await import('@/stores/telemetry')

describe('telemetryStore', () => {
  beforeEach(() => {
    useTelemetryStore.setState({
      consent: 'undecided',
      deviceId: null,
      isInitialized: false,
      feedbackCache: new Map(),
      starRatingCache: new Map(),
      isGeneratingReports: false,
    })
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

  it('getFeedback returns undefined for unknown message', () => {
    const result = useTelemetryStore.getState().getFeedback('unknown-id')
    expect(result).toBeUndefined()
  })
})
