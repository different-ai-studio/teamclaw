import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentSelectorDock } from '../AgentSelectorDock'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: [], error: null }),
        in: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
  },
}))

vi.mock('@/stores/runtime-state-store', () => ({
  useRuntimeStateStore: (selector: (s: unknown) => unknown) =>
    selector({ byRuntimeId: {} }),
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: (selector: (s: unknown) => unknown) =>
    selector({ rows: [] }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) =>
    selector({ activeSessionId: null }),
}))

vi.mock('@/lib/teamclaw-rpc', () => ({
  setModel: vi.fn(),
}))

describe('AgentSelectorDock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows "No agent" placeholder when no agent is engaged', () => {
    render(
      <AgentSelectorDock
        engagedAgent={null}
        onEngageAgent={vi.fn()}
      />,
    )
    expect(screen.getByText('No agent')).toBeInTheDocument()
  })

  it('renders the engaged agent display name', () => {
    render(
      <AgentSelectorDock
        engagedAgent={{ id: 'a-1', displayName: 'Reviewer Bot' }}
        onEngageAgent={vi.fn()}
      />,
    )
    expect(screen.getByText('Reviewer Bot')).toBeInTheDocument()
  })
})
