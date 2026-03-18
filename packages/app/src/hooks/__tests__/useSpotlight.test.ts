import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      spotlightMode: false,
    }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    onFocusChanged: vi.fn().mockResolvedValue(() => {}),
    hide: vi.fn(),
  })),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useSpotlight', () => {
  it('returns pinned as false initially', async () => {
    const { useSpotlight } = await import('@/hooks/useSpotlight')
    const { result } = renderHook(() => useSpotlight())
    expect(result.current.pinned).toBe(false)
  })

  it('exposes togglePin function', async () => {
    const { useSpotlight } = await import('@/hooks/useSpotlight')
    const { result } = renderHook(() => useSpotlight())
    expect(typeof result.current.togglePin).toBe('function')
  })

  it('exposes expandToMain function', async () => {
    const { useSpotlight } = await import('@/hooks/useSpotlight')
    const { result } = renderHook(() => useSpotlight())
    expect(typeof result.current.expandToMain).toBe('function')
  })
})
