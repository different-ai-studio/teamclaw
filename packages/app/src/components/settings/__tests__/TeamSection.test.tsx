import * as React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ---------------------------------------------------------------------------
// Hoisted, mutable store state — each test assigns before render.
// ---------------------------------------------------------------------------
const currentTeam = vi.hoisted(() => ({ teamId: null as string | null }))
const workspace = vi.hoisted(() => ({
  workspacePath: null as string | null,
}))
const teamShare = vi.hoisted(() => ({
  mode: null as 'oss' | 'managed_git' | 'custom_git' | null,
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

vi.mock('../team/TeamShareSection', () => ({
  TeamShareSection: (props: {
    teamId: string
    workspacePath: string
    onConfigured?: () => void | Promise<void>
  }) => (
    <div data-testid="onboarding">
      onboarding:{props.teamId}:{props.workspacePath}
      {props.onConfigured && (
        <button
          type="button"
          data-testid="simulate-configured"
          onClick={() => void props.onConfigured?.()}
        >
          simulate configured
        </button>
      )}
    </div>
  ),
}))
vi.mock('../team/TeamDefaultAgentConfig', () => ({
  TeamDefaultAgentConfig: () => <div data-testid="default-agent-config">agent</div>,
}))
vi.mock('../team/TeamGitConfig', () => ({
  TeamGitConfig: () => <div data-testid="git-config">git</div>,
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
  it('shows the onboarding wizard for an unconfigured team with a workspace', async () => {
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    // share status resolves async (spinner first), then the wizard renders.
    expect((await screen.findByTestId('onboarding')).textContent).toContain(
      'onboarding:team-1:/ws',
    )
    expect(screen.queryByTestId('git-config')).toBeNull()
    expect(screen.queryByTestId('oss-status')).toBeNull()
  })

  it('shows the missing-prereq notice when there is no team/workspace context', () => {
    render(<TeamSection />)
    // PR #224: no team + no workspace surfaces the prereq notice, not the git form.
    expect(screen.queryByTestId('onboarding')).toBeNull()
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

  it('routes an unconfigured team (no cloud shareMode) to the onboarding wizard', async () => {
    teamShare.mode = null
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(await screen.findByTestId('onboarding')).toBeTruthy()
    expect(screen.queryByTestId('git-config')).toBeNull()
    expect(screen.queryByTestId('oss-status')).toBeNull()
  })

  it('shows the Git config for a locked git share mode', async () => {
    teamShare.mode = 'managed_git'
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(await screen.findByTestId('git-config')).toBeTruthy()
    expect(screen.queryByTestId('oss-status')).toBeNull()
  })

  it('routes to the git detail view after the onboarding wizard completes', async () => {
    const user = userEvent.setup()
    teamShare.mode = null
    teamShare.refresh = vi
      .fn()
      .mockResolvedValueOnce({
        mode: null,
        gitRemoteUrl: null,
        gitAuthKind: null,
        enabledAt: null,
      })
      .mockResolvedValueOnce({
        mode: 'custom_git',
        gitRemoteUrl: 'https://git.example.com/repo.git',
        gitAuthKind: 'ssh_key',
        enabledAt: '2026-01-01T00:00:00Z',
      })
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(await screen.findByTestId('onboarding')).toBeTruthy()
    await user.click(screen.getByTestId('simulate-configured'))
    expect(await screen.findByTestId('git-config')).toBeTruthy()
    expect(screen.queryByTestId('onboarding')).toBeNull()
  })

  it('shows the onboarding wizard when FC returns null even if the store snapshot had git mode', async () => {
    // Regression: routing must follow refresh() result, not a stale zustand value.
    teamShare.mode = null
    teamShare.refresh = vi.fn().mockResolvedValue({
      mode: null,
      gitRemoteUrl: 'https://git.example.com/orphan.git',
      gitAuthKind: 'https_token',
      enabledAt: null,
    })
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(await screen.findByTestId('onboarding')).toBeTruthy()
    expect(screen.queryByTestId('git-config')).toBeNull()
  })
})
