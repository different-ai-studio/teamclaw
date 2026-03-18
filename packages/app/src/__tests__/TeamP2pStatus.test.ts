import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
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

const mockInvoke = vi.fn(async (cmd: string) => {
  if (cmd === 'team_check_git_installed') return { installed: true, version: '2.40.0' }
  if (cmd === 'get_team_config') return null
  if (cmd === 'get_device_info') return { nodeId: 'test-node', platform: 'macos', arch: 'aarch64', hostname: 'test-mac' }
  if (cmd === 'get_p2p_config') return { enabled: true, tickets: [{ ticket: 'test-ticket', label: 'Team Alpha', addedAt: '2024-01-01' }], publishEnabled: false, lastSyncAt: null }
  if (cmd === 'p2p_sync_status') return null
  if (cmd === 'p2p_reconnect') return null
  return null
})

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {}
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  }
})

describe('TeamP2P Shared Content Display', () => {
  it('shows shared content card in P2P tab', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    // P2P tab is active by default; shared content is always visible
    expect(screen.getByText('skills/')).toBeDefined()
    expect(screen.getByText('.mcp/')).toBeDefined()
    expect(screen.getByText('knowledge/')).toBeDefined()
  })

  it('shows shared content info text', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    // P2P tab is active by default
    expect(screen.getByText(/synced via P2P/i)).toBeDefined()
  })
})
