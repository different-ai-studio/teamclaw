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
  it('renders the Git team configuration without sync-method tabs', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    const tabs = screen.queryAllByRole('tab')
    expect(tabs.length).toBe(0)
    expect(screen.queryByText('S3')).toBeNull()
  })

  it('renders a heading for the Team Shared section', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    expect(screen.getByRole('heading', { name: 'Team Shared' })).toBeInTheDocument()
  })

  it('does not render sync-method tabs as the default surface', async () => {
    const { TeamSection } = await import('../components/settings/TeamSection')

    await act(async () => {
      render(React.createElement(TeamSection))
    })

    expect(screen.queryAllByRole('tab').length).toBe(0)
  })
})
