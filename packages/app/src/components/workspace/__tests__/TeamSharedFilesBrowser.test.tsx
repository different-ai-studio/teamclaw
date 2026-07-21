import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const fileBrowserMock = vi.hoisted(() => vi.fn(() => <div data-testid="file-browser" />))

const workspaceState = vi.hoisted(() => ({
  workspacePath: '/workspace',
  refreshFileTree: vi.fn(),
}))

const teamModeState = vi.hoisted(() => ({
  teamModeType: null as string | null,
}))

const teamShareState = vi.hoisted(() => ({
  mode: null as 'oss' | 'managed_git' | 'custom_git' | null,
  globalPath: '/home/.amuxd/teams/team-1/teamclaw-team' as string | null,
  refresh: vi.fn().mockResolvedValue({ mode: null }),
}))

const ossSyncState = vi.hoisted(() => ({
  syncing: false,
  refresh: vi.fn().mockResolvedValue(undefined),
  syncNow: vi.fn().mockResolvedValue(undefined),
}))

const currentTeamState = vi.hoisted(() => ({
  teamId: 'team-1' as string | null,
}))

const isTauriMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(true),
  readDir: vi.fn().mockResolvedValue([{ name: 'a.md', isDirectory: false }]),
}))

vi.mock('@/components/workspace/FileBrowser', () => ({
  FileBrowser: fileBrowserMock,
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: typeof workspaceState) => unknown) => selector(workspaceState),
}))

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: Object.assign(
    (selector: (state: typeof teamModeState) => unknown) => selector(teamModeState),
    {
      setState: vi.fn(),
      getState: () => ({
        loadTeamGitFileSyncStatus: vi.fn(),
      }),
    },
  ),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (state: { team: { id: string } | null }) => unknown) =>
    selector({ team: currentTeamState.teamId ? { id: currentTeamState.teamId } : null }),
}))

vi.mock('@/stores/team-share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/team-share')>()
  return {
    ...actual,
    useTeamShareStore: (
      selector: (state: {
        status: { mode: typeof teamShareState.mode; globalPath: string | null }
        refresh: typeof teamShareState.refresh
      }) => unknown,
    ) =>
      selector({
        status: { mode: teamShareState.mode, globalPath: teamShareState.globalPath },
        refresh: teamShareState.refresh,
      }),
  }
})

vi.mock('@/stores/oss-sync', () => ({
  useOssSyncStore: (selector: (state: typeof ossSyncState) => unknown) => selector(ossSyncState),
}))

vi.mock('@/lib/daemon-local-client', () => ({
  linkDaemonTeamWorkspace: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => isTauriMock(),
  cn: (...args: string[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/lib/build-config', () => ({
  TEAM_REPO_DIR: 'teamclaw-team',
  TEAM_SYNCED_EVENT: 'teamclaw-team-synced',
}))

vi.mock('@/lib/team-skill-paths', () => ({
  globalTeamShareDir: vi.fn().mockResolvedValue('/home/.amuxd/teams/team-1/teamclaw-team'),
}))

import { TeamSharedFilesBrowser } from '../TeamSharedFilesBrowser'

describe('TeamSharedFilesBrowser', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    workspaceState.workspacePath = '/workspace'
    teamModeState.teamModeType = null
    teamShareState.mode = null
    teamShareState.globalPath = '/home/.amuxd/teams/team-1/teamclaw-team'
    teamShareState.refresh = vi.fn().mockResolvedValue({ mode: null })
    currentTeamState.teamId = 'team-1'
    isTauriMock.mockReturnValue(true)
    const { exists, readDir } = await import('@tauri-apps/plugin-fs')
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readDir).mockResolvedValue([
      { name: 'a.md', isDirectory: false } as never,
    ])
  })

  it('scopes FileBrowser to the global team shared directory when populated', async () => {
    render(<TeamSharedFilesBrowser />)

    await vi.waitFor(() => {
      expect(fileBrowserMock).toHaveBeenCalled()
    })

    const props = fileBrowserMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(props.rootPath).toBe('/home/.amuxd/teams/team-1/teamclaw-team')
    expect(props.hideGitStatus).toBe(false)
  })

  it('renders nothing when workspace path is missing', () => {
    workspaceState.workspacePath = null as unknown as string
    const { container } = render(<TeamSharedFilesBrowser />)
    expect(container).toBeEmptyDOMElement()
  })

  it('passes a git sync action icon when FC share mode is custom_git', async () => {
    teamShareState.mode = 'custom_git'

    render(<TeamSharedFilesBrowser />)

    await vi.waitFor(() => {
      expect(fileBrowserMock).toHaveBeenCalled()
    })

    const props = fileBrowserMock.mock.calls.at(-1)?.[0] as {
      actionIcons?: React.ReactElement
    }
    expect(props.actionIcons).toBeTruthy()
  })

  it('passes an OSS sync action icon when FC share mode is oss', async () => {
    teamShareState.mode = 'oss'

    render(<TeamSharedFilesBrowser />)

    await vi.waitFor(() => {
      expect(fileBrowserMock).toHaveBeenCalled()
    })

    const props = fileBrowserMock.mock.calls.at(-1)?.[0] as {
      actionIcons?: React.ReactElement
    }
    expect(props.actionIcons).toBeTruthy()
  })

  it('does not pass a sync action icon when team share is not configured', async () => {
    render(<TeamSharedFilesBrowser />)

    await vi.waitFor(() => {
      expect(fileBrowserMock).toHaveBeenCalled()
    })

    const props = fileBrowserMock.mock.calls.at(-1)?.[0] as {
      actionIcons?: React.ReactElement
    }
    expect(props.actionIcons).toBeUndefined()
  })

  it('shows the directory-missing state when the global dir does not exist', async () => {
    const { exists } = await import('@tauri-apps/plugin-fs')
    vi.mocked(exists).mockResolvedValue(false)

    render(<TeamSharedFilesBrowser />)

    expect(
      await screen.findByText(
        'Team shared directory does not exist yet. Sync to fetch it from the team.',
      ),
    ).toBeTruthy()
    expect(fileBrowserMock).not.toHaveBeenCalled()
  })

  it('shows the empty state when the global dir exists but has no entries', async () => {
    const { readDir } = await import('@tauri-apps/plugin-fs')
    vi.mocked(readDir).mockResolvedValue([])

    render(<TeamSharedFilesBrowser />)

    expect(
      await screen.findByText('This team shared directory is empty.'),
    ).toBeTruthy()
    expect(fileBrowserMock).not.toHaveBeenCalled()
  })
})
