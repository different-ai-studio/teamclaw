import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const mockInvoke = vi.hoisted(() => vi.fn())

const workspaceStoreMocks = vi.hoisted(() => ({
  workspacePath: '/workspace-a',
  openCodeReady: true,
}))

const teamMembersStoreMocks = vi.hoisted(() => ({
  loadMembers: vi.fn(),
  loadMyRole: vi.fn(),
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
  TEAM_SYNCED_EVENT: 'team-synced',
  TEAM_REPO_DIR: 'teamclaw-team',
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(workspaceStoreMocks as unknown as Record<string, unknown>),
}))

vi.mock('@/stores/team-members', () => ({
  useTeamMembersStore: () => teamMembersStoreMocks,
}))

vi.mock('./HostLlmConfig', () => ({
  HostLlmConfig: () => <div>Host LLM</div>,
}))

vi.mock('@/components/settings/shared', () => ({
  ToggleSwitch: ({ enabled: _enabled, ...props }: any) => <button {...props} />,
}))

vi.mock('@/components/settings/TeamMemberList', () => ({
  TeamMemberList: () => <div>Team members</div>,
}))

vi.mock('@/components/settings/DeviceIdDisplay', () => ({
  DeviceIdDisplay: () => <div>Device ID</div>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: any) => <div>{children}</div>,
  CollapsibleContent: ({ children }: any) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: any) => <button>{children}</button>,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import { TeamGitConfig } from '../TeamGitConfig'

describe('TeamGitConfig workspace-aware calls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workspaceStoreMocks.workspacePath = '/workspace-a'
    workspaceStoreMocks.openCodeReady = true
    teamMembersStoreMocks.loadMembers.mockReset()
    teamMembersStoreMocks.loadMyRole.mockReset()
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        transformCallback: vi.fn(() => 0),
        invoke: vi.fn(async () => null),
      },
      configurable: true,
    })
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'team_check_git_installed') return { installed: true, version: 'git version 2.0.0' }
      if (cmd === 'get_team_config') return null
      if (cmd === 'get_device_info') return { nodeId: 'node-123' }
      return null
    })
  })

  it('passes workspacePath when loading the Git team config', async () => {
    render(<TeamGitConfig />)

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_team_config', { workspacePath: '/workspace-a' })
    })
  })

  it('passes workspacePath when initializing secrets for a configured Git team', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'team_check_git_installed') return { installed: true, version: 'git version 2.0.0' }
      if (cmd === 'get_team_config') {
        return {
          gitUrl: 'https://example.com/repo.git',
          enabled: false,
          lastSyncAt: null,
          teamId: 'team-123',
        }
      }
      if (cmd === 'init_git_team_secrets') return null
      if (cmd === 'get_team_status') return { active: true, llm: null }
      if (cmd === 'get_device_info') return { nodeId: 'node-123' }
      return null
    })

    render(<TeamGitConfig />)

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('init_git_team_secrets', {
        teamId: 'team-123',
        workspacePath: '/workspace-a',
      })
    })
  })
})
