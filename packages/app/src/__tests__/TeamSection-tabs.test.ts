import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
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
  if (cmd === 'p2p_sync_status') return null
  if (cmd === 'webdav_get_status') return null
  if (cmd === 'get_device_info') return { nodeId: 'test-node', platform: 'macos', arch: 'aarch64', hostname: 'test-mac' }
  if (cmd === 'get_p2p_config') return null
  if (cmd === 'p2p_reconnect') return null
  if (cmd === 'unified_team_get_members') return []
  if (cmd === 'unified_team_get_my_role') return null
  return null
})

// Mock Tauri invoke to prevent real API calls
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

// Mock Tauri event API
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

// Mock plugin-fs
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async () => ''),
  exists: vi.fn(async () => false),
}))

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {}
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
    transformCallback: vi.fn(() => Math.random()),
  }
})

describe('TeamSection tab switcher', () => {
  it('renders two tabs: P2P and S3', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    const tabs = screen.queryAllByRole('tab')
    expect(tabs.length).toBe(2)
    expect(tabs[0].textContent).toBe('P2P')
    expect(tabs[1].textContent).toBe('S3')
  })

  it('renders a heading for the Team section', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    const headings = screen.getAllByRole('heading')
    expect(headings.length).toBeGreaterThan(0)
  })

  it('P2P tab is selected by default', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    const tabs = screen.queryAllByRole('tab')
    const p2pTab = tabs.find(t => t.textContent === 'P2P')
    expect(p2pTab?.getAttribute('aria-selected')).toBe('true')
  })
})
