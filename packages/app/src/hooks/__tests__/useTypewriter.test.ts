import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useTypewriter', () => {
  it('returns the full text immediately for small content', async () => {
    const { useTypewriter } = await import('@/hooks/useTypewriter')
    const { result } = renderHook(() => useTypewriter('Hello world', false))
    expect(result.current.displayedText).toBe('Hello world')
    expect(result.current.isRevealing).toBe(false)
  })

  it('snaps to new text when text shrinks', async () => {
    const { useTypewriter } = await import('@/hooks/useTypewriter')
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useTypewriter(text, streaming),
      { initialProps: { text: 'Hello world', streaming: false } },
    )
    expect(result.current.displayedText).toBe('Hello world')

    // Shrink the text
    rerender({ text: 'Hi', streaming: false })
    expect(result.current.displayedText).toBe('Hi')
    expect(result.current.isRevealing).toBe(false)
  })

  it('shows text immediately for small incremental updates', async () => {
    const { useTypewriter } = await import('@/hooks/useTypewriter')
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useTypewriter(text, streaming),
      { initialProps: { text: 'Hello', streaming: true } },
    )
    expect(result.current.displayedText).toBe('Hello')

    // Small delta (< 80 chars threshold)
    rerender({ text: 'Hello world!', streaming: true })
    expect(result.current.displayedText).toBe('Hello world!')
  })
})
