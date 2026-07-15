import * as React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// New aggregate shape from the daemon: mode/lastSyncAt/syncing/lastError +
// pulled/pushed/conflicts counters. No per-file detail (dirtyCount / totalFiles
// / recentFiles) anymore.
const oss = vi.hoisted(() => ({
  mode: 'oss' as string | null,
  lastSyncAt: null as string | null,
  syncing: false,
  pulled: 0,
  pushed: 0,
  conflicts: 0,
  lastError: null as string | null,
  refresh: vi.fn().mockResolvedValue(undefined),
  syncNow: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: string) => fb ?? _k, i18n: { language: 'en' } }),
}))
vi.mock('@/lib/utils', () => ({ isTauri: () => true, cn: (...a: string[]) => a.join(' ') }))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: { team: { id: string } | null }) => unknown) =>
    sel({ team: { id: 'team-1' } }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: { workspacePath: string | null }) => unknown) =>
    sel({ workspacePath: '/ws' }),
}))
vi.mock('@/stores/oss-sync', () => ({
  useOssSyncStore: (sel: (s: typeof oss) => unknown) => sel(oss),
}))

import { TeamOssSyncStatus } from '../TeamOssSyncStatus'

beforeEach(() => {
  oss.mode = 'oss'
  oss.lastSyncAt = null
  oss.syncing = false
  oss.pulled = 0
  oss.pushed = 0
  oss.conflicts = 0
  oss.lastError = null
  oss.refresh = vi.fn().mockResolvedValue(undefined)
  oss.syncNow = vi.fn().mockResolvedValue(undefined)
})

describe('TeamOssSyncStatus', () => {
  it('renders the aggregate sync status and refreshes on mount', async () => {
    oss.lastSyncAt = '2026-05-29T06:30:00Z'
    oss.pulled = 4
    oss.pushed = 2
    render(<TeamOssSyncStatus />)
    expect(screen.getByText('Idle')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    await waitFor(() => expect(oss.refresh).toHaveBeenCalledWith('/ws'))
  })

  it('shows a syncing indicator while syncing', () => {
    oss.syncing = true
    render(<TeamOssSyncStatus />)
    expect(screen.getByText('Syncing…')).toBeInTheDocument()
  })

  it('surfaces lastError prominently', () => {
    oss.lastError = 'remote rejected push'
    render(<TeamOssSyncStatus />)
    expect(screen.getByText('Error')).toBeInTheDocument()
    expect(screen.getByText('remote rejected push')).toBeInTheDocument()
  })

  it('triggers a manual sync when "Sync now" is clicked', () => {
    render(<TeamOssSyncStatus />)
    fireEvent.click(screen.getByTestId('oss-sync-now'))
    expect(oss.syncNow).toHaveBeenCalledWith('/ws')
  })
})
