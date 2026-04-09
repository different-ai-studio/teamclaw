import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import * as React from 'react'

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback
      if (typeof fallback === 'object' && fallback && 'defaultValue' in fallback) return (fallback as { defaultValue: string }).defaultValue
      return key
    },
  }),
}))

// Mock Tauri event API to prevent transformCallback errors
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

const mockDeviceInfo = {
  nodeId: 'my-device-node-id-abcdef123456',
  platform: 'macos',
  arch: 'aarch64',
  hostname: 'my-macbook',
}

const connectedSyncStatus = {
  connected: true,
  role: 'owner',
  docTicket: 'ticket-abc',
  namespaceId: 'ns-123',
  lastSyncAt: null,
  members: [
    {
      nodeId: 'my-device-node-id-abcdef123456',
      label: 'my-macbook',
      platform: 'macos',
      arch: 'aarch64',
      hostname: 'my-macbook',
      addedAt: '2026-01-01T00:00:00Z',
    },
  ],
}

let addMemberResult: null | Error = null

const mockInvoke = vi.fn(async (cmd: string, _args?: Record<string, unknown>) => {
  if (cmd === 'get_device_info') return mockDeviceInfo
  if (cmd === 'get_p2p_config') return null
  if (cmd === 'p2p_sync_status') return connectedSyncStatus
  if (cmd === 'webdav_get_status') return null
  if (cmd === 'p2p_reconnect') return null
  if (cmd === 'team_add_member') {
    if (addMemberResult instanceof Error) throw addMemberResult
    return null
  }
  if (cmd === 'team_remove_member') return null
  // Team members store commands
  if (cmd === 'unified_team_get_members') return connectedSyncStatus.members.map(m => ({ ...m, role: 'owner', name: m.hostname }))
  if (cmd === 'unified_team_get_my_role') return 'owner'
  if (cmd === 'list_team_members') return connectedSyncStatus.members.map(m => ({ ...m, role: 'owner', name: m.hostname }))
  if (cmd === 'get_my_role') return 'owner'
  return null
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

// Mock plugin-fs to prevent import errors
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async () => ''),
  exists: vi.fn(async () => false),
}))

beforeEach(() => {
  vi.clearAllMocks()
  addMemberResult = null
  ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {}
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
    transformCallback: vi.fn(() => Math.random()),
  }
  ;(window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: vi.fn(),
  }
})

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: { workspacePath: string }) => unknown) =>
    selector({ workspacePath: '/workspace/test' }),
}))

const { mockEngineInit, mockEngineFetch, mockLoadVersionedFiles } = vi.hoisted(() => ({
  mockEngineInit: vi.fn(async () => () => {}),
  mockEngineFetch: vi.fn(async () => undefined),
  mockLoadVersionedFiles: vi.fn(),
}))

vi.mock('@/stores/version-history', () => ({
  useVersionHistoryStore: () => ({
    versionedFiles: [],
    loading: false,
    loadVersionedFiles: mockLoadVersionedFiles,
  }),
}))

vi.mock('@/stores/p2p-engine', () => {
  const engineState = {
    snapshot: { status: 'idle', streamHealth: 'good', uptimeSecs: 0, restartCount: 0, peers: [], syncedFiles: 0, pendingFiles: 0 },
    init: mockEngineInit,
  }
  const fn = Object.assign(
    (selector: (s: typeof engineState) => unknown) => selector(engineState),
    { getState: () => ({ ...engineState, fetch: mockEngineFetch }) },
  )
  return { useP2pEngineStore: fn }
})

vi.mock('@/stores/team-members', () => {
  const membersState = {
    members: [],
    myRole: null,
    loading: false,
    fetchMembers: vi.fn(),
    setMyRole: vi.fn(),
    loadMembers: vi.fn(),
    loadMyRole: vi.fn(),
    loadCurrentNodeId: vi.fn(),
    currentNodeId: null,
    error: null,
    applications: [],
    addMember: vi.fn(),
    removeMember: vi.fn(),
    updateMemberRole: vi.fn(),
    canManageMembers: () => false,
    approveApplication: vi.fn(),
    listenForApplications: vi.fn(),
    cleanupApplicationsListener: vi.fn(),
    reset: vi.fn(),
    _unlistenApplications: null,
  }
  return { useTeamMembersStore: () => membersState }
})

vi.mock('@/stores/team-mode', () => {
  const store = {
    teamModeType: null,
    p2pConnected: false,
    p2pConfigured: false,
    myRole: null,
    clearTeamMode: vi.fn(),
  }
  const fn = (selector: (s: typeof store) => unknown) => selector(store)
  fn.setState = vi.fn()
  fn.getState = () => store
  return { useTeamModeStore: fn }
})

vi.mock('@/stores/team-oss', () => ({
  useTeamOssStore: (selector: (s: { configured: boolean; connected: boolean }) => unknown) =>
    selector({ configured: false, connected: false }),
}))

describe('TeamSection Allowlist Integration', () => {
  it('P2P content shows Device ID section', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    // P2P content is directly visible — no tab switching required
    // Wait for device info to load
    await waitFor(() => {
      // Should show the Device ID somewhere
      expect(screen.getAllByText(/my-devic/).length).toBeGreaterThan(0)
    })
  })

  it('P2P content shows team member list when owner', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    // P2P content is directly visible — no tab switching required
    // Wait for sync status to load (shows connected state with owner role)
    await waitFor(() => {
      expect(screen.getAllByText('Owner').length).toBeGreaterThan(0)
    })
  })
})
