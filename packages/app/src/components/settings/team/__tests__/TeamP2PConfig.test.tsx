import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const mockInvoke = vi.hoisted(() => vi.fn())

const teamModeStoreMocks = vi.hoisted(() => ({
  setState: vi.fn(),
  clearTeamMode: vi.fn(),
  teamApiKey: null,
  setTeamApiKey: vi.fn(),
  myRole: null as 'owner' | 'editor' | 'viewer' | null,
}))

const p2pEngineStoreMocks = vi.hoisted(() => ({
  initialized: true,
  snapshot: {
    status: 'connected',
    streamHealth: 'healthy',
    uptimeSecs: 120,
    restartCount: 0,
    lastSyncAt: '2024-01-01T00:00:00Z',
    peers: [],
    syncedFiles: 0,
    pendingFiles: 0,
  },
  init: vi.fn(async () => () => {}),
  fetch: vi.fn(async () => {}),
}))

const workspaceStoreMocks = vi.hoisted(() => ({
  workspacePath: '/workspace-a',
  refreshFileTree: vi.fn(),
}))

const mockListen = vi.hoisted(() => vi.fn(async () => () => {}))

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

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  copyToClipboard: vi.fn(),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/lib/build-config', () => ({
  buildConfig: {
    app: { name: 'TeamClaw' },
    team: { seedUrl: '' },
  },
  TEAMCLAW_DIR: '.teamclaw',
  TEAM_REPO_DIR: 'teamclaw-team',
}))

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel(teamModeStoreMocks as unknown as Record<string, unknown>),
    {
      setState: teamModeStoreMocks.setState,
      getState: () => teamModeStoreMocks,
    },
  ),
}))

vi.mock('@/stores/p2p-engine', () => ({
  useP2pEngineStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel(p2pEngineStoreMocks as unknown as Record<string, unknown>),
    {
      getState: () => ({
        snapshot: p2pEngineStoreMocks.snapshot,
        initialized: p2pEngineStoreMocks.initialized,
        init: p2pEngineStoreMocks.init,
        fetch: p2pEngineStoreMocks.fetch,
      }),
    },
  ),
}))

vi.mock('@/stores/team-members', () => ({
  useTeamMembersStore: () => ({})
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(workspaceStoreMocks as unknown as Record<string, unknown>),
}))

vi.mock('@/components/settings/DeviceIdDisplay', () => ({
  DeviceIdDisplay: ({ nodeId }: { nodeId: string }) => <div>{nodeId}</div>,
}))

vi.mock('@/components/settings/TeamMemberList', () => ({
  TeamMemberList: () => <div>Team members</div>,
}))

vi.mock('@/components/settings/team/VersionHistorySection', () => ({
  VersionHistorySection: () => <div>Version history</div>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />, 
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: () => <div />,
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

import { TeamP2PConfig } from '../TeamP2PConfig'

describe('TeamP2PConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    teamModeStoreMocks.teamApiKey = null
    teamModeStoreMocks.setTeamApiKey = vi.fn()
    teamModeStoreMocks.clearTeamMode = vi.fn()
    teamModeStoreMocks.myRole = null
    p2pEngineStoreMocks.initialized = true
    p2pEngineStoreMocks.snapshot = {
      status: 'connected',
      streamHealth: 'healthy',
      uptimeSecs: 120,
      restartCount: 0,
      lastSyncAt: '2024-01-01T00:00:00Z',
      peers: [],
      syncedFiles: 0,
      pendingFiles: 0,
    }
    p2pEngineStoreMocks.init = vi.fn(async () => () => {})
    p2pEngineStoreMocks.fetch = vi.fn(async () => {})
    workspaceStoreMocks.workspacePath = '/workspace-a'
    workspaceStoreMocks.refreshFileTree = vi.fn()
    mockListen.mockClear()
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        transformCallback: vi.fn(() => 0),
        invoke: vi.fn(async () => null),
      },
      configurable: true,
    })
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_device_info') {
        return { nodeId: 'node-123' }
      }
      if (cmd === 'p2p_sync_status') {
        return {
          connected: true,
          role: 'owner',
          docTicket: 'ticket-1',
          namespaceId: 'team-1',
          lastSyncAt: '2024-01-01T00:00:00Z',
          members: [],
          ownerNodeId: 'node-123',
          seedUrl: null,
          teamSecret: 'secret',
        }
      }
      return null
    })
  })

  it('shows connected state without triggering reconnect on mount', async () => {
    render(<TeamP2PConfig />)

    expect(screen.getByText('Team Drive Active')).toBeDefined()
    expect(screen.queryByText('Connecting to team...')).toBeNull()

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_device_info', undefined)
      expect(mockInvoke).toHaveBeenCalledWith('p2p_sync_status', undefined)
    })

    expect(mockInvoke).not.toHaveBeenCalledWith('p2p_reconnect', undefined)
  })

  it('reloads sync status when workspace changes', async () => {
    let syncStatusCalls = 0
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_device_info') {
        return { nodeId: 'node-123' }
      }
      if (cmd === 'p2p_sync_status') {
        syncStatusCalls += 1
        return syncStatusCalls === 1
          ? {
              connected: true,
              role: 'owner',
              docTicket: 'ticket-a',
              namespaceId: 'team-a',
              lastSyncAt: '2024-01-01T00:00:00Z',
              members: [],
              ownerNodeId: 'node-123',
              seedUrl: null,
              teamSecret: 'secret-a',
            }
          : {
              connected: false,
              role: null,
              docTicket: null,
              namespaceId: null,
              lastSyncAt: null,
              members: [],
              ownerNodeId: null,
              seedUrl: null,
              teamSecret: null,
            }
      }
      return null
    })

    const { rerender } = render(<TeamP2PConfig />)

    await waitFor(() => {
      expect(screen.getByText('Team Drive Active')).toBeDefined()
    })

    workspaceStoreMocks.workspacePath = '/workspace-b'
    p2pEngineStoreMocks.snapshot = {
      status: 'disconnected',
      streamHealth: 'dead',
      uptimeSecs: 0,
      restartCount: 0,
      lastSyncAt: null,
      peers: [],
      syncedFiles: 0,
      pendingFiles: 0,
    }
    rerender(<TeamP2PConfig />)

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledTimes(4)
    })

    await waitFor(() => {
      expect(screen.queryByText('Team Drive Active')).toBeNull()
    })
  })
})
