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

const mockInvoke = vi.fn(async (cmd: string) => {
  if (cmd === 'team_check_git_installed') return { installed: true, version: '2.40.0' }
  if (cmd === 'get_team_config') return null
  if (cmd === 'get_device_info') return {
    nodeId: 'test-node-id-123',
    platform: 'macos',
    arch: 'aarch64',
    hostname: 'test-mac',
  }
  if (cmd === 'get_p2p_config') return null
  if (cmd === 'p2p_sync_status') return null
  if (cmd === 'p2p_reconnect') return null
  return null
})

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

describe('TeamSection Legacy Git Tab', () => {
  it('Git tab label shows "Legacy" badge', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    // The Git tab should show a "Legacy" badge
    const gitTab = screen.getByRole('tab', { name: /git/i })
    expect(gitTab.textContent).toContain('Legacy')
  })

  it('Git tab content shows deprecation banner', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    // Switch to Git tab (P2P is default now)
    fireEvent.click(screen.getByRole('tab', { name: /git/i }))

    // Git tab should show deprecation banner
    await waitFor(() => {
      expect(screen.getByText(/deprecated/i)).toBeDefined()
    })
  })
})
