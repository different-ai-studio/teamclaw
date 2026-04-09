import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import * as React from 'react'
import type { TeamMember } from '@/lib/git/types'

// Mock Tauri event API to prevent transformCallback errors
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

const ownerMember: TeamMember = {
  nodeId: 'owner-node-id-abcdef',
  label: 'Owner Device',
  platform: 'macos',
  arch: 'aarch64',
  hostname: 'macbook-pro',
  addedAt: '2026-01-01T00:00:00Z',
  role: 'owner',
  name: 'Owner Device',
}

const regularMember: TeamMember = {
  nodeId: 'member-node-id-123456',
  label: 'Dev Machine',
  platform: 'linux',
  arch: 'x86_64',
  hostname: 'dev-box',
  addedAt: '2026-01-02T00:00:00Z',
  role: 'editor',
  name: 'Dev Machine',
}

// Mutable role so each test can override what the store loads
let testRole: string | null = 'owner'

const mockInvoke = vi.fn(async (cmd: string) => {
  if (cmd === 'unified_team_get_members') return [ownerMember, regularMember]
  if (cmd === 'unified_team_get_my_role') return testRole
  return null
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

beforeEach(async () => {
  testRole = 'owner'
  vi.clearAllMocks()
  cleanup()
  // Reset store state between tests
  const { useTeamMembersStore } = await import('@/stores/team-members')
  useTeamMembersStore.setState({
    members: [],
    myRole: null,
    loading: false,
    error: null,
    applications: [],
    _unlistenApplications: null,
  })
})

afterEach(() => {
  cleanup()
})

describe('TeamMemberList', () => {
  it('renders members with metadata', async () => {
    const { TeamMemberList } = await import('../components/settings/TeamMemberList')

    await act(async () => {
      render(React.createElement(TeamMemberList))
    })

    expect(screen.getAllByText(/Owner Device/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Dev Machine/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/macos/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/linux/).length).toBeGreaterThan(0)
  })

  it('shows Owner badge on owner member', async () => {
    const { TeamMemberList } = await import('../components/settings/TeamMemberList')

    await act(async () => {
      render(React.createElement(TeamMemberList))
    })

    expect(screen.getByText('Owner')).toBeDefined()
  })

  it('shows Remove buttons when myRole=owner', async () => {
    testRole = 'owner'
    const { TeamMemberList } = await import('../components/settings/TeamMemberList')

    await act(async () => {
      render(React.createElement(TeamMemberList))
    })

    // Should have a remove button for the non-owner member only
    const removeButtons = screen.getAllByRole('button', { name: /remove/i })
    expect(removeButtons.length).toBe(1)
  })

  it('hides Remove buttons when myRole=viewer', async () => {
    testRole = 'viewer'
    const { TeamMemberList } = await import('../components/settings/TeamMemberList')

    await act(async () => {
      render(React.createElement(TeamMemberList))
    })

    const removeButtons = screen.queryAllByRole('button', { name: /remove/i })
    expect(removeButtons.length).toBe(0)
  })
})
