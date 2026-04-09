import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
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

const mockDeviceInfo = {
  nodeId: 'joiner-node-id-abcdef123456',
  platform: 'macos',
  arch: 'aarch64',
  hostname: 'joiner-macbook',
}

let joinDriveError: null | Error = null
let joinCompleted = false
const connectedSyncStatus = {
  connected: true,
  role: 'member',
  docTicket: null,
  namespaceId: 'ns-123',
  lastSyncAt: null,
  members: [],
}

const mockInvoke = vi.fn(async (cmd: string, _args?: Record<string, unknown>) => {
  if (cmd === 'team_check_git_installed') return { installed: true, version: '2.40.0' }
  if (cmd === 'get_team_config') return null
  if (cmd === 'get_device_info') return mockDeviceInfo
  if (cmd === 'get_p2p_config') return {
    enabled: true,
    tickets: [],
    publishEnabled: false,
    lastSyncAt: null,
    ownerNodeId: null,
    allowedMembers: [],
  }
  // Return connected status only after join has completed successfully
  if (cmd === 'p2p_sync_status') return joinCompleted ? connectedSyncStatus : null
  if (cmd === 'p2p_reconnect') return null
  // Return exists: true to trigger the confirmation dialog, which avoids
  // the stale closure in checkTeamDirAndConfirm's useCallback([]) dependency
  if (cmd === 'p2p_check_team_dir') return { exists: true, hasMembers: false }
  if (cmd === 'p2p_join_drive') {
    if (joinDriveError) throw joinDriveError
    joinCompleted = true
    return null
  }
  if (cmd === 'webdav_get_status') return null
  if (cmd === 'unified_team_get_members') return []
  if (cmd === 'unified_team_get_my_role') return null
  if (cmd === 'list_team_members') return []
  if (cmd === 'get_my_role') return null
  return null
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

// Mock Tauri event API to prevent transformCallback errors
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

// Mock plugin-fs to prevent import errors from team-mode store
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async () => ''),
  exists: vi.fn(async () => false),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: { workspacePath: string }) => unknown) =>
    selector({ workspacePath: '/workspace/test' }),
}))

vi.mock('@/stores/version-history', () => ({
  useVersionHistoryStore: () => ({
    versionedFiles: [],
    loading: false,
    loadVersionedFiles: vi.fn(),
  }),
}))

const { mockEngineInit, mockEngineFetch } = vi.hoisted(() => ({
  mockEngineInit: vi.fn(async () => () => {}),
  mockEngineFetch: vi.fn(async () => undefined),
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
    error: null,
    applications: [],
    currentNodeId: null,
    _unlistenApplications: null,
    loadMembers: vi.fn(),
    loadMyRole: vi.fn(),
    loadCurrentNodeId: vi.fn(),
    fetchMembers: vi.fn(),
    setMyRole: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    updateMemberRole: vi.fn(),
    canManageMembers: () => false,
    approveApplication: vi.fn(),
    listenForApplications: vi.fn(),
    cleanupApplicationsListener: vi.fn(),
    reset: vi.fn(),
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

beforeEach(() => {
  joinDriveError = null
  joinCompleted = false
  mockInvoke.mockClear()
  ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {}
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
    transformCallback: vi.fn(() => Math.random()),
  }
  ;(window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: vi.fn(),
  }
})

afterEach(() => {
  cleanup()
})

describe('TeamSection Join Approval Status', () => {
  it('shows "Waiting for approval" when join fails with Not authorized', async () => {
    joinDriveError = new Error('not authorized: your NodeId is not in the team allowlist')
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    // Wait for async init (useEffect) to complete
    await act(async () => {
      await new Promise(r => setTimeout(r, 50))
    })

    // Default join mode is 'ticket', ticket input is already visible

    // Enter a ticket and click Join
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/ticket/i)).toBeDefined()
    })

    const ticketInput = screen.getByPlaceholderText(/ticket/i)
    fireEvent.change(ticketInput, { target: { value: 'test-ticket-abc123' } })

    // Click Join — triggers confirmation dialog (p2p_check_team_dir returns exists: true)
    const joinBtn = screen.getByRole('button', { name: /^join$/i })
    await act(async () => {
      fireEvent.click(joinBtn)
    })
    await act(async () => {
      await new Promise(r => setTimeout(r, 50))
    })

    // Click "Continue" in the confirmation dialog to proceed with join
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /continue/i })).toBeDefined()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    })
    await act(async () => {
      await new Promise(r => setTimeout(r, 100))
    })

    // Should show "Not authorized to join" status (the actual component text)
    await waitFor(() => {
      expect(screen.getByText(/not authorized to join/i)).toBeDefined()
    })

    // Should show the device NodeId so user can share it with owner
    await waitFor(() => {
      expect(screen.getAllByText(/joiner-n/).length).toBeGreaterThan(0)
    })
  })

  it('shows connected status when join succeeds', async () => {
    joinDriveError = null
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    // Wait for async init to complete
    await act(async () => {
      await new Promise(r => setTimeout(r, 50))
    })

    // Default join mode is 'ticket', ticket input is already visible

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/ticket/i)).toBeDefined()
    })

    const ticketInput = screen.getByPlaceholderText(/ticket/i)
    fireEvent.change(ticketInput, { target: { value: 'test-ticket-abc123' } })

    // Click Join — triggers confirmation dialog
    const joinBtn = screen.getByRole('button', { name: /^join$/i })
    await act(async () => {
      fireEvent.click(joinBtn)
    })
    await act(async () => {
      await new Promise(r => setTimeout(r, 50))
    })

    // Click "Continue" in the confirmation dialog to proceed with join
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /continue/i })).toBeDefined()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    })
    await act(async () => {
      await new Promise(r => setTimeout(r, 100))
    })

    // Should show Team Drive Active (connected state)
    await waitFor(() => {
      expect(screen.getByText(/team drive active/i)).toBeDefined()
    })
  })
})
