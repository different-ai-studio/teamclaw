import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => {
    const state = { workspacePath: '/test' }
    return sel(state)
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'clawhub_list_installed') return { skills: {} }
    if (cmd === 'clawhub_explore') return { items: [], nextCursor: null }
    return null
  }),
}))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' ') }))
vi.mock('@/lib/clawhub/types', () => ({ parseStats: () => ({}) }))
vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { ClawHubMarketplace } from '../ClawHubMarketplace'

describe('ClawHubMarketplace', () => {
  it('renders the search input', () => {
    render(<ClawHubMarketplace />)
    expect(screen.getByPlaceholderText('Search ClawHub skills...')).toBeTruthy()
  })
})
