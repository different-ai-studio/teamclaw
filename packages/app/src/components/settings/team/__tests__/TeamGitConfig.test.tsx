import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'

const mockInvoke = vi.hoisted(() => vi.fn())
const workspaceStoreMocks = vi.hoisted(() => ({
  workspacePath: '/workspace-a',
  workspaceReady: true,
}))
const disconnectShare = vi.hoisted(() => vi.fn(async () => {}))
const shareStoreMocks = vi.hoisted(() => ({
  status: {
    mode: 'managed_git' as 'managed_git' | 'custom_git' | 'oss' | null,
    gitRemoteUrl: 'https://example.com/repo.git' as string | null,
    gitAuthKind: 'https_token' as string | null,
    enabledAt: null as string | null,
    linkStatus: 'symlink' as 'symlink' | 'real_dir' | 'missing' | undefined,
    globalPath: '/home/me/.amuxd/teams/team-1/teamclaw-team' as string | null,
  },
  refresh: vi.fn(async () => ({ ...shareStoreMocks.status })),
  disconnect: disconnectShare,
  getSecret: vi.fn(async () => null),
  setSecret: vi.fn(async () => {}),
  loading: false,
}))

vi.mock('../TeamShareSection', () => ({
  TeamShareSection: () => <div data-testid="team-share-section">Enable team share</div>,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOptions === 'string') return fallbackOrOptions
      if (fallbackOrOptions && typeof fallbackOrOptions.defaultValue === 'string') {
        return fallbackOrOptions.defaultValue
      }
      return key
    },
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  copyToClipboard: vi.fn(),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/lib/build-config', () => ({
  buildConfig: {
    app: { name: 'TeamClaw' },
    team: {
      llm: { baseUrl: '', models: [] },
    },
  },
  appShortName: 'teamclaw',
  appDisplayName: 'TeamClaw',
  TEAM_SYNCED_EVENT: 'team-synced',
  TEAM_REPO_DIR: 'teamclaw-team',
  TEAMCLAW_DIR: '.teamclaw',
}))

const linkDaemonTeamWorkspace = vi.hoisted(() => vi.fn(async () => null))

vi.mock('@/lib/daemon-local-client', () => ({
  linkDaemonTeamWorkspace,
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(workspaceStoreMocks as unknown as Record<string, unknown>),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: { team: { id: string } | null }) => unknown) =>
    sel({ team: { id: 'team-1' } }),
}))

vi.mock('@/lib/team-permissions', () => ({
  useTeamPermissions: () => ({ isOwner: true }),
}))

vi.mock('@/stores/team-share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/team-share')>()
  return {
    ...actual,
    useTeamShareStore: (sel: (s: typeof shareStoreMocks) => unknown) =>
      sel(shareStoreMocks),
  }
})

vi.mock('./TeamSyncPaths', () => ({
  TeamSyncPaths: () => <div>Team Sync Paths</div>,
}))

vi.mock('@/components/auth/DaemonOnboardingWizard', () => ({
  DaemonOnboardingWizard: () => <div data-testid="daemon-onboarding-wizard">wizard</div>,
}))

const forceResetDaemon = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/stores/daemon-onboarding', () => ({
  useDaemonOnboardingStore: (
    sel: (s: { status: string; busy: boolean; forceReset: () => Promise<void> }) => unknown,
  ) => sel({ status: 'idle', busy: false, forceReset: forceResetDaemon }),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: any) => <div>{children}</div>,
  CollapsibleContent: ({ children }: any) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: any) => <button>{children}</button>,
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: any) => (open ? <div>{children}</div> : null),
  AlertDialogContent: ({ children }: any) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
  AlertDialogCancel: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  AlertDialogAction: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import { TeamGitConfig } from '../TeamGitConfig'

describe('TeamGitConfig status panel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workspaceStoreMocks.workspacePath = '/workspace-a'
    workspaceStoreMocks.workspaceReady = true
    shareStoreMocks.status = {
      mode: 'managed_git',
      gitRemoteUrl: 'https://example.com/repo.git',
      gitAuthKind: 'https_token',
      enabledAt: null,
      linkStatus: 'symlink',
      globalPath: '/home/me/.amuxd/teams/team-1/teamclaw-team',
    }
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        transformCallback: vi.fn(() => 0),
        invoke: vi.fn(async () => null),
      },
      configurable: true,
    })
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_daemon_team_id') return 'team-1'
      if (cmd === 'oss_sync_status') {
        return {
          mode: 'git',
          lastSyncAt: '2026-06-05T04:01:54.917Z',
          syncing: false,
          lastError: null,
        }
      }
      if (cmd === 'team_shared_git_sync') return { success: true, message: 'Synced' }
      return null
    })
  })

  it('renders the status surface for a configured git-mode team (no legacy local config read)', async () => {
    render(<TeamGitConfig />)

    // Repo URL + managed-git mode label come from the FC share-mode status.
    expect(await screen.findByText('Managed Git')).toBeTruthy()
    expect(screen.getByText('https://example.com/repo.git')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText(/Last synced/i)).toBeTruthy()
    expect(screen.getByText('Sync Now')).toBeTruthy()
    expect(screen.getByText('Disconnect')).toBeTruthy()
    expect(screen.getByText('How to set up a team repository')).toBeTruthy()
    // Legacy local-config commands are never called.
    expect(mockInvoke).not.toHaveBeenCalledWith('get_team_config', expect.anything())
    expect(mockInvoke).not.toHaveBeenCalledWith('save_team_config', expect.anything())
    // No legacy entry form.
    expect(
      screen.queryByPlaceholderText('https://github.com/team/shared-workspace.git'),
    ).toBeNull()
  })

  it('labels the self-hosted (custom_git) mode and SSH auth', async () => {
    shareStoreMocks.status = {
      mode: 'custom_git',
      gitRemoteUrl: 'git@example.com:team/repo.git',
      gitAuthKind: 'ssh_key',
      enabledAt: null,
      linkStatus: 'symlink',
      globalPath: null,
    }
    render(<TeamGitConfig />)
    expect(await screen.findByText('Self-hosted Git')).toBeTruthy()
    expect(screen.getByText('SSH')).toBeTruthy()
  })

  it('links workspace then syncs through the daemon proxy', async () => {
    render(<TeamGitConfig />)

    const syncButton = await screen.findByText('Sync Now')
    syncButton.click()

    await waitFor(() => {
      expect(linkDaemonTeamWorkspace).toHaveBeenCalledWith('/workspace-a', { strict: true })
      expect(mockInvoke).toHaveBeenCalledWith('team_shared_git_sync', {
        config: { workspacePath: '/workspace-a' },
        force: false,
      })
    })
  })

  it('shows a rebind action and disables sync when daemon team mismatches', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_daemon_team_id') return 'daemon-team-old'
      if (cmd === 'oss_sync_status') {
        return {
          mode: 'git',
          lastSyncAt: null,
          syncing: false,
          lastError: null,
        }
      }
      return null
    })

    render(<TeamGitConfig />)

    await waitFor(() => {
      expect(screen.getByText('daemon-team-old')).toBeTruthy()
      expect(screen.getByRole('button', { name: '重新绑定到当前团队' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Sync Now' })).toBeDisabled()
    })
  })

  it('shows the rebind action (not the raw 422) when the daemon cannot read this team’s share-mode', async () => {
    // team_id matches (no mismatch), cloud share is locked but the workspace is
    // not linked yet, and the daemon's sync reports the dedicated
    // team_share_not_enabled_for_daemon 422. The rebind card must win and the
    // (contradictory) "pending local link → Sync Now" card must be suppressed.
    shareStoreMocks.status = {
      mode: 'custom_git',
      gitRemoteUrl: 'https://git.example.com/team/repo.git',
      gitAuthKind: 'https_token',
      enabledAt: null,
      linkStatus: 'missing',
      globalPath: null,
    }
    const rawDaemonError =
      'daemon /v1/team/sync 422 Unprocessable Entity: ' +
      '{"type":"https://teamclaw/errors/team_share_not_enabled_for_daemon",' +
      '"title":"Team share not enabled for daemon","status":422,' +
      '"detail":"team share is not enabled for daemon team team-1 (share_mode is unset).",' +
      '"code":"team_share_not_enabled_for_daemon"}'
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_daemon_team_id') return 'team-1'
      if (cmd === 'oss_sync_status') {
        return {
          mode: 'git',
          lastSyncAt: null,
          syncing: false,
          lastError: rawDaemonError,
        }
      }
      return null
    })

    render(<TeamGitConfig />)

    await waitFor(() => {
      // Friendly card + rebind action instead of the raw daemon error.
      expect(screen.getByText('本机 Daemon 无法读取团队共享配置')).toBeTruthy()
      expect(screen.getByRole('button', { name: '重新绑定到当前团队' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Sync Now' })).toBeDisabled()
    })
    // The raw 422 string is hidden from the user.
    expect(screen.queryByText(/team_share_not_enabled_for_daemon/)).toBeNull()
    // This is NOT the team-mismatch path, so no team-id comparison is shown.
    expect(screen.queryByText('Daemon 团队')).toBeNull()
    // The contradictory "pending local link → click Sync Now" card is suppressed
    // while a rebind is required (otherwise it tells the user to click a disabled
    // button).
    expect(
      screen.queryByText(/Cloud share is enabled; local directory not linked yet/i),
    ).toBeNull()
  })

  it('shows enable flow when cloud share_mode is unset (legacy git UI trap)', async () => {
    shareStoreMocks.status = {
      mode: null,
      gitRemoteUrl: 'https://git.example.com/team/repo.git',
      gitAuthKind: 'https_token',
      enabledAt: null,
      linkStatus: 'symlink',
      globalPath: null,
    }
    render(<TeamGitConfig />)

    expect(await screen.findByText(/Team share is not enabled on the cloud yet/i)).toBeTruthy()
    expect(screen.getByTestId('team-share-section')).toBeTruthy()
    expect(screen.queryByText('Sync Now')).toBeNull()
    expect(screen.queryByText('Connected')).toBeNull()
  })

  it('shows pending-local-link state when cloud git is enabled but workspace is unlinked', async () => {
    shareStoreMocks.status = {
      mode: 'custom_git',
      gitRemoteUrl: 'https://git.example.com/team/repo.git',
      gitAuthKind: 'https_token',
      enabledAt: '2026-06-11T06:00:00.000Z',
      linkStatus: 'missing',
      globalPath: '/home/me/.amuxd/teams/team-1/teamclaw-team',
    }
    render(<TeamGitConfig />)

    expect(await screen.findByText('Self-hosted Git')).toBeTruthy()
    expect(screen.getByText('Pending local link')).toBeTruthy()
    expect(screen.queryByText('Connected')).toBeNull()
    expect(screen.getByText(/Cloud share is enabled; local directory not linked yet/i)).toBeTruthy()
  })

  it('offers delete-and-reclone instead of a raw 500 when the local dir is not a git repo', async () => {
    const rawDaemonError =
      'daemon /v1/team/sync 422 Unprocessable Entity: ' +
      '{"code":"team_shared_dir_not_git","detail":"team_shared_dir_not_git:/home/me/.amuxd/teams/team-1/teamclaw-team"}'
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_daemon_team_id') return 'team-1'
      if (cmd === 'oss_sync_status') {
        return {
          mode: 'git',
          lastSyncAt: null,
          syncing: false,
          lastError: rawDaemonError,
        }
      }
      if (cmd === 'team_shared_git_sync') {
        return {
          success: false,
          message: 'The local team shared directory exists but is not a git repository.',
          needsConfirmation: true,
          confirmKind: 'wipeNonGitDir',
        }
      }
      return null
    })

    render(<TeamGitConfig />)

    await waitFor(() => {
      expect(screen.getByText('Local team directory is not a git repository')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Delete and re-clone' })).toBeTruthy()
    })
    expect(screen.queryByText(/Internal Server Error/i)).toBeNull()
    expect(screen.queryByText(/team_shared_dir_not_git/)).toBeNull()
  })

  it('disconnects local team materialization with teamId via inline confirm', async () => {
    render(<TeamGitConfig />)

    const toggle = await screen.findByRole('button', { name: 'Disconnect' })
    toggle.click()
    const panel = await screen.findByTestId('disconnect-confirm-panel')
    within(panel).getByRole('button', { name: 'Disconnect' }).click()

    await waitFor(() => {
      expect(disconnectShare).toHaveBeenCalledWith('team-1', '/workspace-a')
    })
  })
})
