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
  if (cmd === 'get_p2p_config') return null
  if (cmd === 'p2p_sync_status') return null
  if (cmd === 'p2p_reconnect') return null
  return null
})

// Mock Tauri invoke to prevent real API calls
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

// Mock window.__TAURI__ to simulate desktop environment
beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {}
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  }
})

describe('TeamSection Tab Switcher', () => {
  it('renders Git and P2P tabs', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    expect(screen.getByRole('tab', { name: /git/i })).toBeDefined()
    expect(screen.getByRole('tab', { name: /p2p/i })).toBeDefined()
  })

  it('defaults to P2P tab', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    const p2pTab = screen.getByRole('tab', { name: /p2p/i })
    expect(p2pTab.getAttribute('aria-selected')).toBe('true')
  })

  it('switches to Git tab on click', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    const gitTab = screen.getByRole('tab', { name: /git/i })
    fireEvent.click(gitTab)

    expect(gitTab.getAttribute('aria-selected')).toBe('true')
    const p2pTab = screen.getByRole('tab', { name: /p2p/i })
    expect(p2pTab.getAttribute('aria-selected')).toBe('false')
  })

  it('preserves P2P tab content when switching back', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    // Switch to Git
    fireEvent.click(screen.getByRole('tab', { name: /git/i }))
    // Switch back to P2P
    fireEvent.click(screen.getByRole('tab', { name: /p2p/i }))

    expect(screen.getByRole('tab', { name: /p2p/i }).getAttribute('aria-selected')).toBe('true')
  })
})
