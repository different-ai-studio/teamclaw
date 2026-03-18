import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TeamWebDavConfig } from '../TeamWebDavConfig'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({
    connected: false,
    syncing: false,
    lastSyncAt: null,
    fileCount: 0,
    error: null,
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k }),
}))

describe('TeamWebDavConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders connection form when disconnected', () => {
    render(<TeamWebDavConfig />)
    expect(screen.getByPlaceholderText(/https:\/\/dav/)).toBeDefined()
    expect(screen.getByText('Connect')).toBeDefined()
  })

  it('disables connect button when URL is empty', () => {
    render(<TeamWebDavConfig />)
    const connectBtn = screen.getByText('Connect')
    expect(connectBtn).toHaveProperty('disabled', true)
  })

  it('shows import button', () => {
    render(<TeamWebDavConfig />)
    expect(screen.getByText('Import Config')).toBeDefined()
  })

  it('shows auth type selector', () => {
    render(<TeamWebDavConfig />)
    expect(screen.getByText('Username + Password')).toBeDefined()
  })

  it('shows sync interval input', () => {
    render(<TeamWebDavConfig />)
    expect(screen.getByText('Sync Interval (minutes)')).toBeDefined()
  })
})
