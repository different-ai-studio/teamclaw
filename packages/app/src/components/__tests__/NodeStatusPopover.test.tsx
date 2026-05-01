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

vi.mock('react-i18next', () => ({
  useTranslation: (() => {
    const translations: Record<string, string> = {
      'common.justNow': 'Just now',
      'common.never': 'Never',
      'nodeStatus.connected': 'Connected',
      'nodeStatus.degraded': 'Degraded',
      'nodeStatus.disconnected': 'Disconnected',
      'nodeStatus.engine': 'Engine',
      'nodeStatus.lastSync': 'Last sync',
      'nodeStatus.online': 'Online',
      'nodeStatus.pendingFiles': 'Pending files',
      'nodeStatus.reconnecting': 'Reconnecting...',
      'nodeStatus.restarts': 'Restarts',
      'nodeStatus.syncedFiles': 'Synced files',
      'nodeStatus.thisDevice': 'This device',
      'nodeStatus.unknown': 'Unknown',
    }
    const t = (key: string, options?: string | { count?: number }) => {
      const count = typeof options === 'object' ? options.count ?? 0 : 0
      if (key === 'nodeStatus.teamMembers') return `Team Members (${count})`
      if (key === 'nodeStatus.secondsAgo') return `${count}s ago`
      if (key === 'nodeStatus.minutesAgoShort') return `${count}m ago`
      if (key === 'nodeStatus.hoursAgoShort') return `${count}h ago`
      if (key === 'nodeStatus.daysAgoShort') return `${count}d ago`
      if (key === 'nodeStatus.staleSeconds') return `${count}s ago`
      if (key === 'nodeStatus.staleMinutes') return `${count}m ago`
      if (key === 'nodeStatus.offlineSeconds') return `${count}s offline`
      if (key === 'nodeStatus.offlineMinutes') return `${count}m offline`
      if (key === 'nodeStatus.offlineHours') return `${count}h offline`
      return translations[key] ?? (typeof options === 'string' ? options : key)
    }
    return () => ({
      i18n: { language: 'en' },
      t,
    })
  })(),
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
