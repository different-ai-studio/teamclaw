import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

const teamState = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (state: { team: { id: string } | null }) => unknown) =>
    selector({ team: teamState.id ? { id: teamState.id } : null }),
}))

const workspaceState = vi.hoisted(() => ({ path: '/workspace' as string | null }))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: { workspacePath: string | null }) => unknown) =>
    selector({ workspacePath: workspaceState.path }),
}))

const { loadCounts, loadSection, setSidebarFilter } = vi.hoisted(() => ({
  loadCounts: vi.fn(),
  loadSection: vi.fn(),
  setSidebarFilter: vi.fn(),
}))
vi.mock('@/stores/team-share-browser', () => ({
  useTeamShareBrowserStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      loadCounts,
      loadSection,
      skills: { items: [] },
      mcp: { items: [] },
      envCount: 0,
      knowledge: { items: [] },
      skillLocalState: {},
    }),
}))
vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ sidebarFilter: { kind: 'sessions' }, setSidebarFilter }),
}))

import { TeamShareNavSection } from '../TeamShareNavSection'

describe('TeamShareNavSection', () => {
  it('loads counts after the current team becomes available', async () => {
    teamState.id = null
    loadCounts.mockReset()

    const view = render(<TeamShareNavSection />)
    expect(loadCounts).not.toHaveBeenCalled()

    teamState.id = 'team-1'
    view.rerender(<TeamShareNavSection />)

    await waitFor(() => expect(loadCounts).toHaveBeenCalledTimes(1))
  })
})
