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
  if (cmd === 'team_check_git_installed') return { installed: true, version: '2.40.0' }
  if (cmd === 'get_team_config') return null
  if (cmd === 'get_device_info') return mockDeviceInfo
  if (cmd === 'get_p2p_config') return null
  if (cmd === 'p2p_sync_status') return connectedSyncStatus
  if (cmd === 'p2p_reconnect') return null
  if (cmd === 'team_add_member') {
    if (addMemberResult instanceof Error) throw addMemberResult
    return null
  }
  if (cmd === 'team_remove_member') return null
  return null
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

beforeEach(() => {
  vi.clearAllMocks()
  addMemberResult = null
  ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {}
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  }
})

describe('TeamSection Allowlist Integration', () => {
  it('P2P tab shows Device ID section', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    // P2P tab is active by default; wait for device info to load
    await waitFor(() => {
      // Should show the Device ID somewhere
      expect(screen.getAllByText(/my-devic/).length).toBeGreaterThan(0)
    })
  })

  it('P2P tab shows team member list when owner', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    // Wait for sync status to load (shows connected state with owner role)
    await waitFor(() => {
      expect(screen.getAllByText('Owner').length).toBeGreaterThan(0)
    })
  })
})
