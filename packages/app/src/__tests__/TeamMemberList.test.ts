import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import * as React from 'react'
import type { TeamMember } from '@/lib/git/types'

beforeEach(() => {
  vi.clearAllMocks()
})

const ownerMember: TeamMember = {
  nodeId: 'owner-node-id-abcdef',
  label: 'Owner Device',
  platform: 'macos',
  arch: 'aarch64',
  hostname: 'macbook-pro',
  addedAt: '2026-01-01T00:00:00Z',
}

const regularMember: TeamMember = {
  nodeId: 'member-node-id-123456',
  label: 'Dev Machine',
  platform: 'linux',
  arch: 'x86_64',
  hostname: 'dev-box',
  addedAt: '2026-01-02T00:00:00Z',
}

describe('TeamMemberList', () => {
  it('renders members with metadata', async () => {
    const { TeamMemberList } = await import('../components/settings/TeamMemberList')
    render(React.createElement(TeamMemberList, {
      members: [ownerMember, regularMember],
      ownerNodeId: ownerMember.nodeId,
      isOwner: false,
      onRemove: vi.fn(),
    }))

    expect(screen.getByText(/Owner Device/)).toBeDefined()
    expect(screen.getByText(/Dev Machine/)).toBeDefined()
    expect(screen.getByText(/macos/)).toBeDefined()
    expect(screen.getByText(/linux/)).toBeDefined()
  })

  it('shows Owner badge on owner member', async () => {
    const { TeamMemberList } = await import('../components/settings/TeamMemberList')
    render(React.createElement(TeamMemberList, {
      members: [ownerMember, regularMember],
      ownerNodeId: ownerMember.nodeId,
      isOwner: false,
      onRemove: vi.fn(),
    }))

    expect(screen.getByText('Owner')).toBeDefined()
  })

  it('shows Remove buttons when isOwner=true', async () => {
    const onRemove = vi.fn()
    const { TeamMemberList } = await import('../components/settings/TeamMemberList')
    render(React.createElement(TeamMemberList, {
      members: [ownerMember, regularMember],
      ownerNodeId: ownerMember.nodeId,
      isOwner: true,
      onRemove,
    }))

    // Should have a remove button for the non-owner member
    const removeButtons = screen.getAllByRole('button', { name: /remove/i })
    expect(removeButtons.length).toBe(1) // only for non-owner

    fireEvent.click(removeButtons[0])
    expect(onRemove).toHaveBeenCalledWith(regularMember.nodeId)
  })

  it('hides Remove buttons when isOwner=false', async () => {
    const { TeamMemberList } = await import('../components/settings/TeamMemberList')
    render(React.createElement(TeamMemberList, {
      members: [ownerMember, regularMember],
      ownerNodeId: ownerMember.nodeId,
      isOwner: false,
      onRemove: vi.fn(),
    }))

    const removeButtons = screen.queryAllByRole('button', { name: /remove/i })
    expect(removeButtons.length).toBe(0)
  })
})
