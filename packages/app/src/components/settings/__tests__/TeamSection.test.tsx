import * as React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Hoisted, mutable store state — each test assigns before render.
// ---------------------------------------------------------------------------
const currentTeam = vi.hoisted(() => ({ teamId: null as string | null }))
const workspace = vi.hoisted(() => ({
  workspacePath: null as string | null,
}))
const teamShare = vi.hoisted(() => ({
  mode: null as 'oss' | null,
  refresh: vi.fn(),
}))

function mockRefreshFromMode() {
  teamShare.refresh = vi.fn().mockImplementation(() =>
    Promise.resolve({
      mode: teamShare.mode,
      gitRemoteUrl: teamShare.mode ? 'https://example.com/repo.git' : null,
      gitAuthKind: teamShare.mode ? 'https_token' : null,
      enabledAt: teamShare.mode ? '2026-01-01T00:00:00Z' : null,
    }),
  )
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true, cn: (...a: string[]) => a.join(' ') }))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (
    sel: (s: { team: { id: string } | null }) => unknown,
  ) => sel({ team: currentTeam.teamId ? { id: currentTeam.teamId } : null }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: typeof workspace) => unknown) => sel(workspace),
}))
vi.mock('@/stores/team-share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/team-share')>()
  return {
    ...actual,
    useTeamShareStore: (
      sel: (s: { status: { mode: unknown }; refresh: unknown }) => unknown,
    ) => sel({ status: { mode: teamShare.mode }, refresh: teamShare.refresh }),
  }
})

vi.mock('@/lib/team-permissions', () => ({
  useTeamPermissions: () => ({ role: 'owner', isOwner: true, canManageTeam: true, canEditFiles: true }),
}))

vi.mock('../team/TeamDefaultAgentConfig', () => ({
  TeamDefaultAgentConfig: () => <div data-testid="default-agent-config">agent</div>,
}))
vi.mock('../team/TeamOssSyncStatus', () => ({
  TeamOssSyncStatus: () => <div data-testid="oss-status">oss</div>,
}))

import { TeamSection } from '../TeamSection'

beforeEach(() => {
  currentTeam.teamId = null
  workspace.workspacePath = null
  teamShare.mode = null
  mockRefreshFromMode()
})

describe('TeamSection share-mode gating', () => {
  it('points an unconfigured team at the Knowledge panel instead of a wizard', async () => {
    // Enabling moved to the Knowledge list column, where the empty state it
    // fixes is on screen. Settings only reports.
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(await screen.findByTestId('not-enabled')).toBeTruthy()
    expect(screen.queryByTestId('git-config')).toBeNull()
    expect(screen.queryByTestId('oss-status')).toBeNull()
  })

  it('shows the missing-prereq notice when there is no team/workspace context', () => {
    render(<TeamSection />)
    // PR #224: no team + no workspace surfaces the prereq notice, not the git form.
    expect(screen.queryByTestId('not-enabled')).toBeNull()
    expect(screen.queryByTestId('git-config')).toBeNull()
    expect(screen.queryByTestId('oss-status')).toBeNull()
  })

  it("routes shareMode 'oss' to the OSS sync status, not the git form", async () => {
    teamShare.mode = 'oss'
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(await screen.findByTestId('oss-status')).toBeTruthy()
    expect(screen.queryByTestId('git-config')).toBeNull()
  })

  it('routes an unconfigured team (no cloud shareMode) to the not-enabled notice', async () => {
    teamShare.mode = null
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(await screen.findByTestId('not-enabled')).toBeTruthy()
    expect(screen.queryByTestId('oss-status')).toBeNull()
  })

  it('shows the not-enabled notice when FC returns null even if the store snapshot had git mode', async () => {
    // Regression: routing must follow refresh() result, not a stale zustand value.
    teamShare.mode = null
    teamShare.refresh = vi.fn().mockResolvedValue({
      mode: null,
      enabledAt: null,
    })
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(await screen.findByTestId('not-enabled')).toBeTruthy()
    expect(screen.queryByTestId('git-config')).toBeNull()
  })
})
