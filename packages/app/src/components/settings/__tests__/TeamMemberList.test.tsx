import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const mockInvoke = vi.hoisted(() => vi.fn())

const teamMembersStoreMock = vi.hoisted(() => ({
  members: [],
  myRole: 'owner',
  loading: false,
  error: null,
  loadMembers: vi.fn(),
  loadMyRole: vi.fn(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  updateMemberRole: vi.fn(),
  canManageMembers: vi.fn(() => true),
  applications: [],
  approveApplication: vi.fn(),
  listenForApplications: vi.fn(),
  cleanupApplicationsListener: vi.fn(),
}))

const p2pEngineStoreMock = vi.hoisted(() => ({
  snapshot: {
    peers: [],
  },
}))

vi.mock('@/stores/team-members', () => ({
  useTeamMembersStore: () => teamMembersStoreMock,
}))

vi.mock('@/stores/p2p-engine', () => ({
  useP2pEngineStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(p2pEngineStoreMock as unknown as Record<string, unknown>),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

vi.mock('@/components/settings/AddMemberInput', () => ({
  AddMemberInput: () => <div>Add member input</div>,
}))

import { TeamMemberList } from '../TeamMemberList'

describe('TeamMemberList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    teamMembersStoreMock.members = [
      {
        nodeId: 'node-1',
        name: 'Alice',
        label: 'Alice MacBook',
        role: 'owner',
        platform: 'macOS',
        arch: 'arm64',
        hostname: 'alice-macbook',
        addedAt: new Date().toISOString(),
      },
      {
        nodeId: 'node-2',
        name: 'Bob',
        label: 'Bob Linux',
        role: 'viewer',
        platform: 'linux',
        arch: 'x64',
        hostname: 'bob-linux',
        addedAt: new Date().toISOString(),
      },
      {
        nodeId: 'node-3',
        name: 'Carol',
        label: 'Carol Studio',
        role: 'owner',
        platform: 'macOS',
        arch: 'arm64',
        hostname: 'carol-studio',
        addedAt: new Date().toISOString(),
      },
    ]
    p2pEngineStoreMock.snapshot = {
      peers: [
        {
          nodeId: 'node-3',
          name: 'Carol',
          role: 'owner',
          connection: 'active',
          lastSeenSecsAgo: 3,
          entriesSent: 0,
          entriesReceived: 0,
        },
      ],
    }
    mockInvoke.mockResolvedValue({ nodeId: 'node-1' })
  })

  it('shows This device for the local member, real state for remote owner, and Unknown for unmatched remote members', async () => {
    render(<TeamMemberList />)

    expect(screen.getByText('Alice')).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByText('This device')).toBeTruthy()
    })
    expect(screen.getByText('Carol')).toBeTruthy()
    expect(screen.getByText('Online')).toBeTruthy()
    expect(screen.getByText('Unknown')).toBeTruthy()
  })
})
