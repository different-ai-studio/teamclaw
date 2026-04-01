import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockInvoke = vi.hoisted(() => vi.fn())
const fetchMock = vi.hoisted(() => vi.fn())

const p2pEngineStoreMock = vi.hoisted(() => ({
  snapshot: {
    status: 'connected',
    streamHealth: 'healthy',
    uptimeSecs: 120,
    restartCount: 0,
    lastSyncAt: '2024-01-01T00:00:00Z',
    peers: [],
    syncedFiles: 3,
    pendingFiles: 0,
  },
  fetch: fetchMock,
}))

const teamMembersStoreMock = vi.hoisted(() => ({
  members: [],
  currentNodeId: null,
  loadCurrentNodeId: vi.fn(),
}))

vi.mock('@/stores/p2p-engine', () => ({
  useP2pEngineStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(p2pEngineStoreMock as unknown as Record<string, unknown>),
}))

vi.mock('@/stores/team-members', () => ({
  useTeamMembersStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(teamMembersStoreMock as unknown as Record<string, unknown>),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  isTauri: () => true,
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: any) => <div>{children}</div>,
  PopoverTrigger: ({ children }: any) => <>{children}</>,
  PopoverContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}))

vi.mock('@/components/ui/separator', () => ({
  Separator: () => <div />, 
}))

import { NodeStatusPopover } from '../NodeStatusPopover'

describe('NodeStatusPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    teamMembersStoreMock.currentNodeId = 'local-node'
    teamMembersStoreMock.loadCurrentNodeId = vi.fn(async () => {})
    teamMembersStoreMock.members = [
      {
        nodeId: 'local-node',
        name: 'Matt',
        role: 'owner',
        hostname: 'matt-mac',
      },
      {
        nodeId: 'owner-remote',
        name: 'Alice',
        role: 'owner',
        hostname: 'alice-mac',
      },
      {
        nodeId: 'editor-remote',
        name: 'Bob',
        role: 'editor',
        hostname: 'bob-linux',
      },
    ]
    p2pEngineStoreMock.snapshot = {
      status: 'connected',
      streamHealth: 'healthy',
      uptimeSecs: 120,
      restartCount: 0,
      lastSyncAt: '2024-01-01T00:00:00Z',
      peers: [
        {
          nodeId: 'owner-remote',
          name: 'Alice',
          role: 'owner',
          connection: 'active',
          lastSeenSecsAgo: 5,
          entriesSent: 0,
          entriesReceived: 0,
        },
      ],
      syncedFiles: 3,
      pendingFiles: 0,
    }
    mockInvoke.mockResolvedValue({ nodeId: 'local-node' })
  })

  it('opens on hover and shows self, remote owner, and unknown member states', async () => {
    render(
      <NodeStatusPopover>
        <button>Workspace</button>
      </NodeStatusPopover>,
    )

    fireEvent.mouseEnter(screen.getByText('Workspace'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
      expect(screen.getByText('Team Members (3)')).toBeTruthy()
    })

    expect(screen.getByText('This device')).toBeTruthy()
    expect(screen.getByText('Online')).toBeTruthy()
    expect(screen.getByText('Unknown')).toBeTruthy()
  })
})
