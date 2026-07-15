import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

// Mock isTauri
vi.mock('@/lib/utils', () => ({ isTauri: () => true, cn: (...a: string[]) => a.join(' ') }))

// Mock Tauri event listener
const mockUnlisten = vi.fn()
const mockListen = vi.fn().mockResolvedValue(mockUnlisten)
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => mockListen(...args) }))

// Mock MCP store
const mockSyncFromFile = vi.fn()
vi.mock('@/stores/mcp', () => ({
  useMCPStore: { getState: () => ({ syncFromFile: mockSyncFromFile }) },
}))

import { useMCPFileWatcher } from '../useMCPFileWatcher'

describe('useMCPFileWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers file-change listener when workspacePath is provided', async () => {
    renderHook(() => useMCPFileWatcher('/test/workspace'))
    await vi.waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith('file-change', expect.any(Function))
    })
  })

  it('does not register listener when workspacePath is null', () => {
    renderHook(() => useMCPFileWatcher(null))
    expect(mockListen).not.toHaveBeenCalled()
  })

  it('cleans up listener on unmount', async () => {
    const { unmount } = renderHook(() => useMCPFileWatcher('/test/workspace'))
    await vi.waitFor(() => {
      expect(mockListen).toHaveBeenCalled()
    })
    unmount()
    expect(mockUnlisten).toHaveBeenCalled()
  })
})
