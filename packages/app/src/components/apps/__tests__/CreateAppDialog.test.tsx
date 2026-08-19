import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CreateAppDialog, isValidGitRemoteUrl } from '../CreateAppDialog'

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

// The name field is selected by role, not by placeholder copy: `t` is mocked
// to return the fallback string, so a placeholder reword breaks every test
// that reaches the form. It already did — this suite went red on the copy
// change in #626, not on a behaviour change.
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

/** The name input — the dialog also has the optional repo field. */
const nameField = () => screen.getByLabelText('Name')
const repoField = () => screen.getByLabelText('Repository URL (optional)')

describe('CreateAppDialog', () => {
  it('submits trimmed name + literal type + default visibility, then closes', async () => {
    const onOpenChange = vi.fn()
    render(<CreateAppDialog open onOpenChange={onOpenChange} teamId="team-1" />)

    fireEvent.change(nameField(), { target: { value: '  My app  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(createMock).toHaveBeenCalledWith({
      teamId: 'team-1',
      name: 'My app',
      // Pinned deliberately: this is DEFAULT_APP_TYPE, and an unintended
      // change to it silently alters what every new app gets built as.
      // `fullstack_tanstack_postgres` is now LEGACY_DATA_APP_TYPE — the id
      // stored on apps created before the type split, never a new default.
      type: 'static_web',
      visibility: 'personal',
      // No repo typed → null, not undefined: "seed from the template" is a
      // decision the create call states, not one the API infers.
      gitRemoteUrl: null,
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

    fireEvent.change(nameField(), { target: { value: 'Shared app' } })
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

    fireEvent.change(nameField(), { target: { value: 'My app' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument())
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('passes an optional repo URL through, trimmed', async () => {
    render(<CreateAppDialog open onOpenChange={vi.fn()} teamId="team-1" />)

    fireEvent.change(nameField(), { target: { value: 'Imported' } })
    fireEvent.change(repoField(), {
      target: { value: '  https://github.com/owner/repo.git  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ gitRemoteUrl: 'https://github.com/owner/repo.git' }),
    )
  })

  it('blocks submit on a repo URL git would not clone', async () => {
    render(<CreateAppDialog open onOpenChange={vi.fn()} teamId="team-1" />)

    fireEvent.change(nameField(), { target: { value: 'Imported' } })
    fireEvent.change(repoField(), { target: { value: 'ext::sh -c whoami' } })

    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    expect(repoField()).toHaveAttribute('aria-invalid', 'true')

    // ...and clearing it goes back to a plain template app.
    fireEvent.change(repoField(), { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
  })
})

describe('isValidGitRemoteUrl', () => {
  it('accepts what git treats as an address, and nothing else', () => {
    for (const ok of [
      '',
      '   ',
      'https://github.com/owner/repo.git',
      'http://git.internal/owner/repo',
      'ssh://git@github.com/owner/repo.git',
      'git://example.com/repo.git',
      'git@github.com:owner/repo.git',
    ]) {
      expect(isValidGitRemoteUrl(ok), ok).toBe(true)
    }
    for (const bad of [
      'ext::sh -c whoami',
      '--upload-pack=x',
      '/etc/passwd',
      'file:///etc/passwd',
      'https://example.com/repo .git',
    ]) {
      expect(isValidGitRemoteUrl(bad), bad).toBe(false)
    }
  })
})
