import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileInputButton } from '../FileInputButton'

const platformState = vi.hoisted(() => ({ tauriInvoke: false }))

vi.mock('@/lib/platform', () => ({
  capabilities: {
    get tauriInvoke() {
      return platformState.tauriInvoke
    },
  },
}))

const openDialog = vi.fn()
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openDialog(...args),
}))

describe('FileInputButton', () => {
  beforeEach(() => {
    platformState.tauriInvoke = false
    openDialog.mockReset()
  })

  it('opens a browser file input when Tauri is unavailable', () => {
    const onFilesSelected = vi.fn()
    const onBrowserFilesSelected = vi.fn()
    render(
      <FileInputButton
        onFilesSelected={onFilesSelected}
        onBrowserFilesSelected={onBrowserFilesSelected}
      />,
    )

    const input = screen.getByTestId('file-input-browser') as HTMLInputElement
    const clickSpy = vi.spyOn(input, 'click')

    fireEvent.click(screen.getByRole('button', { name: /attach files/i }))
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(openDialog).not.toHaveBeenCalled()

    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(onBrowserFilesSelected).toHaveBeenCalledWith([file])
    expect(onFilesSelected).not.toHaveBeenCalled()
  })

  it('uses the Tauri dialog on desktop', async () => {
    platformState.tauriInvoke = true
    openDialog.mockResolvedValue(['/tmp/a.png'])
    const onFilesSelected = vi.fn()
    const onBrowserFilesSelected = vi.fn()

    render(
      <FileInputButton
        onFilesSelected={onFilesSelected}
        onBrowserFilesSelected={onBrowserFilesSelected}
      />,
    )

    expect(screen.queryByTestId('file-input-browser')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /attach files/i }))
    await vi.waitFor(() => {
      expect(openDialog).toHaveBeenCalledTimes(1)
      expect(onFilesSelected).toHaveBeenCalledWith(['/tmp/a.png'])
    })
    expect(onBrowserFilesSelected).not.toHaveBeenCalled()
  })
})
