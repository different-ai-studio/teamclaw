import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => {
    const state = { workspacePath: null }
    return sel(state)
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/opencode/sdk-client', () => ({ initOpenCodeClient: vi.fn() }))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' '), isTauri: () => false }))
vi.mock('@/lib/opencode/config', () => ({
  readSkillPermissions: vi.fn(async () => ({})),
  writeSkillPermission: vi.fn(),
  removeSkillPermission: vi.fn(),
  resolveSkillPermission: vi.fn(() => ({ permission: 'allow', isExact: false })),
}))
vi.mock('@/lib/git/types', () => ({
  INHERENT_SKILL_NAMES: new Set(),
}))
vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}))
vi.mock('../ClawHubMarketplace', () => ({ ClawHubMarketplace: () => null }))

import { SkillsSection } from '../SkillsSection'

describe('SkillsSection', () => {
  it('renders the Skills title', () => {
    render(<SkillsSection />)
    expect(screen.getByText('Skills')).toBeTruthy()
  })

  it('shows workspace selection prompt when no workspace', () => {
    render(<SkillsSection />)
    expect(screen.getByText('Please select a workspace directory first')).toBeTruthy()
  })
})
