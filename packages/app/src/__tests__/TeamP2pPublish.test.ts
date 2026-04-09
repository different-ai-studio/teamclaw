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

// Mock Tauri event API to prevent transformCallback errors
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

// Mock plugin-fs to prevent import errors
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(async () => []),
  readTextFile: vi.fn(async () => ''),
  exists: vi.fn(async () => false),
}))

const mockInvoke = vi.fn(async (cmd: string) => {
  if (cmd === 'get_device_info') return { nodeId: 'test-node', platform: 'macos', arch: 'aarch64', hostname: 'test-mac' }
  if (cmd === 'get_p2p_config') return null
  if (cmd === 'p2p_sync_status') return null
  if (cmd === 'webdav_get_status') return null
  if (cmd === 'p2p_reconnect') return null
  if (cmd === 'p2p_check_team_dir') return { exists: false, hasMembers: false }
  if (cmd === 'p2p_create_team') return 'ok'
  if (cmd === 'unified_team_get_members') return []
  if (cmd === 'unified_team_get_my_role') return null
  if (cmd === 'list_team_members') return []
  if (cmd === 'get_my_role') return null
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
    transformCallback: vi.fn(() => Math.random()),
  }
})

async function renderTeamSection() {
  const { TeamSection } = await import('../components/settings/TeamSection')
  await act(async () => {
    render(React.createElement(TeamSection))
  })
  // P2P content is directly visible — no tab switching required
}

describe('TeamP2P Publish Flow', () => {
  it('shows "Create Team" button in P2P content', async () => {
    await renderTeamSection()

    await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: /create team/i })
      expect(buttons.length).toBeGreaterThan(0)
    })
  })

  it('opens create form when "Create Team" button is clicked', async () => {
    await renderTeamSection()

    // Wait for init effects
    await act(async () => {
      await new Promise(r => setTimeout(r, 50))
    })

    // Click the "Create Team" button to open the form
    await act(async () => {
      const buttons = screen.getAllByRole('button', { name: /create team/i })
      fireEvent.click(buttons[0])
    })

    // The form should now be visible with a team name input
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/team name/i)).toBeDefined()
    })
  })

  it('shows cancel button in create form', async () => {
    await renderTeamSection()

    await act(async () => {
      await new Promise(r => setTimeout(r, 50))
    })

    // Open the create form
    await act(async () => {
      const buttons = screen.getAllByRole('button', { name: /create team/i })
      fireEvent.click(buttons[0])
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel/i })).toBeDefined()
    })
  })

  it('hides form when cancel is clicked', async () => {
    await renderTeamSection()

    await act(async () => {
      await new Promise(r => setTimeout(r, 50))
    })

    // Open the create form
    await act(async () => {
      const buttons = screen.getAllByRole('button', { name: /create team/i })
      fireEvent.click(buttons[0])
    })

    // Cancel
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    })

    // Form input should no longer be visible
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/team name/i)).toBeNull()
    })
  })
})
