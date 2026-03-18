import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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

let joinResult: string | Error = 'ok'
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
  if (cmd === 'get_device_info') return { nodeId: 'test-node', platform: 'macos', arch: 'aarch64', hostname: 'test-mac' }
  if (cmd === 'get_p2p_config') return null
  if (cmd === 'p2p_sync_status') return joinCompleted ? connectedSyncStatus : null
  if (cmd === 'p2p_reconnect') return null
  // Return exists: true to trigger confirmation dialog, which avoids
  // the stale closure in checkTeamDirAndConfirm's useCallback([]) dependency
  if (cmd === 'p2p_check_team_dir') return { exists: true, hasMembers: false }
  if (cmd === 'p2p_join_drive') {
    if (joinResult instanceof Error) throw joinResult
    joinCompleted = true
    return joinResult
  }
  if (cmd === 'p2p_disconnect_source') return null
  if (cmd === 'save_p2p_config') return null
  return null
})

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

beforeEach(() => {
  vi.clearAllMocks()
  joinResult = 'ok'
  joinCompleted = false
  ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {}
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  }
})

describe('TeamP2P Join Flow', () => {
  it('shows ticket input and Join button in P2P tab', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    // P2P tab is active by default
    expect(screen.getByPlaceholderText(/ticket/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /join/i })).toBeDefined()
  })

  it('shows inline error for invalid ticket', async () => {
    joinResult = new Error('Invalid ticket format')

    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    // Wait for init effects
    await act(async () => {
      await new Promise(r => setTimeout(r, 50))
    })

    const input = screen.getByPlaceholderText(/ticket/i)
    fireEvent.change(input, { target: { value: 'bad-ticket' } })

    // Click Join — triggers confirmation dialog (p2p_check_team_dir returns exists: true)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /join/i }))
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

    await waitFor(() => {
      expect(screen.getByText(/invalid ticket format/i)).toBeDefined()
    })
  })
})
