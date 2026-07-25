import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CloseToTrayHost } from '@/components/CloseToTrayDialog'

const invoke = vi.fn()
const listen = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args),
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return { ...actual, isTauri: () => true }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

describe('CloseToTrayHost', () => {
  beforeEach(() => {
    invoke.mockReset()
    listen.mockReset()
    listen.mockImplementation(async (_event: string, handler: (e: unknown) => void) => {
      // Stash handler for window-close-requested
      if (_event === 'window-close-requested') {
        ;(listen as unknown as { _close?: (e: unknown) => void })._close = handler
      }
      return () => {}
    })
  })

  it('defaults to tray and hides without remembering', async () => {
    render(<CloseToTrayHost />)
    await waitFor(() => expect(listen).toHaveBeenCalled())

    const handler = (listen as unknown as { _close?: () => void })._close
    expect(handler).toBeTypeOf('function')
    handler!()

    expect(await screen.findByTestId('close-to-tray-dialog')).toBeTruthy()
    expect(screen.getByTestId('close-choice-tray').getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByTestId('close-confirm'))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('hide_main_to_tray')
    })
    expect(invoke).not.toHaveBeenCalledWith(
      'set_window_close_preference',
      expect.anything(),
    )
  })

  it('remembers quit preference then quits', async () => {
    render(<CloseToTrayHost />)
    await waitFor(() => expect(listen).toHaveBeenCalled())
    const handler = (listen as unknown as { _close?: () => void })._close
    handler!()

    fireEvent.click(await screen.findByTestId('close-choice-quit'))
    fireEvent.click(screen.getByTestId('close-remember'))
    fireEvent.click(screen.getByTestId('close-confirm'))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set_window_close_preference', { action: 'quit' })
      expect(invoke).toHaveBeenCalledWith('quit_app')
    })
  })
})
