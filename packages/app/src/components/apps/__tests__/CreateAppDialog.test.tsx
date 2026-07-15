import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CreateAppDialog } from '../CreateAppDialog'

const t = (_k: string, fallback?: string) => fallback ?? _k

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
}))

// Mock the Dialog wrapper so the test never mounts Radix FocusScope/portal —
// mirrors IdeaDetailDialog.test.tsx and sidesteps any jsdom focus loop entirely.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

const createMock = vi.fn()

vi.mock('@/stores/apps-store', () => ({
  useAppsStore: {
    getState: () => ({ create: createMock }),
  },
}))

beforeEach(() => {
  createMock.mockReset()
  createMock.mockResolvedValue({ id: 'app-1', name: 'My app' })
})

describe('CreateAppDialog', () => {
  it('submits trimmed name + literal type + default visibility, then closes', async () => {
    const onOpenChange = vi.fn()
    render(<CreateAppDialog open onOpenChange={onOpenChange} teamId="team-1" />)

    fireEvent.change(screen.getByPlaceholderText('My app'), {
      target: { value: '  My app  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(createMock).toHaveBeenCalledWith({
      teamId: 'team-1',
      name: 'My app',
      type: 'fullstack_tanstack_postgres',
      visibility: 'personal',
    })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('submit is disabled with an empty name', () => {
    render(<CreateAppDialog open onOpenChange={vi.fn()} teamId="team-1" />)
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it('submits team visibility when the team radio is selected', async () => {
    const onOpenChange = vi.fn()
    render(<CreateAppDialog open onOpenChange={onOpenChange} teamId="team-1" />)

    fireEvent.change(screen.getByPlaceholderText('My app'), {
      target: { value: 'Shared app' },
    })
    fireEvent.click(screen.getByDisplayValue('team'))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'team', name: 'Shared app' }),
    )
  })

  it('keeps the dialog open and shows an error when create fails', async () => {
    createMock.mockRejectedValueOnce(new Error('boom'))
    const onOpenChange = vi.fn()
    render(<CreateAppDialog open onOpenChange={onOpenChange} teamId="team-1" />)

    fireEvent.change(screen.getByPlaceholderText('My app'), {
      target: { value: 'My app' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument())
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
