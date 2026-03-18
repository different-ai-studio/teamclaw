import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      selectedFile: null,
      openPanel: vi.fn(),
      closePanel: vi.fn(),
      activeTab: 'tasks',
      selectFile: vi.fn(),
    }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      todos: [],
      sessionDiff: [],
    }),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      layoutMode: 'task',
      setFileModeRightTab: vi.fn(),
    }),
}))

vi.mock('@/stores/tabs', () => ({
  useTabsStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({ tabs: [], activeTabId: null }),
    { getState: () => ({ openTab: vi.fn(), tabs: [], activeTabId: null }) },
  ),
  selectActiveTab: () => null,
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('usePanelAutoOpen', () => {
  it('renders without error', async () => {
    const { usePanelAutoOpen } = await import('@/hooks/useFileEditorState')
    const { result } = renderHook(() => usePanelAutoOpen())
    expect(result.current).toBeUndefined()
  })
})

describe('useLayoutModePanelSync', () => {
  it('renders without error', async () => {
    const { useLayoutModePanelSync } = await import('@/hooks/useFileEditorState')
    const { result } = renderHook(() => useLayoutModePanelSync())
    expect(result.current).toBeUndefined()
  })
})

describe('useResizablePanels', () => {
  it('returns initial rightPanelWidth of 400', async () => {
    const { useResizablePanels } = await import('@/hooks/useFileEditorState')
    const { result } = renderHook(() => useResizablePanels())
    expect(result.current.rightPanelWidth).toBe(400)
  })

  it('clamps panel width within min/max bounds', async () => {
    const { useResizablePanels } = await import('@/hooks/useFileEditorState')
    const { result } = renderHook(() => useResizablePanels())

    act(() => {
      // delta is subtracted: negative delta = increase width
      result.current.handleRightPanelResize(-1000)
    })
    expect(result.current.rightPanelWidth).toBe(600) // max

    act(() => {
      result.current.handleRightPanelResize(1000)
    })
    expect(result.current.rightPanelWidth).toBe(280) // min
  })
})

describe('useFileTabSync', () => {
  it('renders without error', async () => {
    const { useFileTabSync } = await import('@/hooks/useFileEditorState')
    const { result } = renderHook(() => useFileTabSync())
    expect(result.current).toBeUndefined()
  })
})

describe('useTabToFileSync', () => {
  it('renders without error', async () => {
    const { useTabToFileSync } = await import('@/hooks/useFileEditorState')
    const { result } = renderHook(() => useTabToFileSync())
    expect(result.current).toBeUndefined()
  })
})
