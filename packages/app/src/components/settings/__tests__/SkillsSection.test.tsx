import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const { workspaceState, mockLoadAllSkills } = vi.hoisted(() => ({
  workspaceState: { workspacePath: null as string | null },
  mockLoadAllSkills: vi.fn(async () => ({ skills: [], overrides: [] })),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => {
    return sel(workspaceState)
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/opencode/sdk-client', () => ({ initOpenCodeClient: vi.fn() }))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' '), isTauri: () => false }))
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => true),
  mkdir: vi.fn(async () => undefined),
}))
vi.mock('@/lib/opencode/config', () => ({
  readSkillPermissions: vi.fn(async () => ({})),
  writeSkillPermission: vi.fn(),
  removeSkillPermission: vi.fn(),
  resolveSkillPermission: vi.fn(() => ({ permission: 'allow', isExact: false })),
}))
vi.mock('@/lib/git/skill-loader', () => ({
  loadAllSkills: mockLoadAllSkills,
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
  beforeEach(() => {
    workspaceState.workspacePath = null
    mockLoadAllSkills.mockReset()
    mockLoadAllSkills.mockResolvedValue({ skills: [], overrides: [] })
  })

  it('shows invocation name for bundled skills', async () => {
    workspaceState.workspacePath = '/workspace/project'
    mockLoadAllSkills.mockResolvedValueOnce({
      skills: [
        {
          filename: 'brainstorming',
          name: 'brainstorming',
          invocationName: 'superpowers/brainstorming',
          content: '---\ndescription: Brainstorm first\n---\nBody',
          source: 'global-agent',
          dirPath: '/home/user/.agents/skills/superpowers',
        },
      ] as any,
      overrides: [],
    })

    render(<SkillsSection />)

    expect(await screen.findByText('superpowers/brainstorming')).toBeTruthy()
  })

  it('renders the Skills title', () => {
    render(<SkillsSection />)
    expect(screen.getByText('Skills')).toBeTruthy()
  })

  it('shows workspace selection prompt when no workspace', () => {
    render(<SkillsSection />)
    expect(screen.getByText('Please select a workspace directory first')).toBeTruthy()
  })
})
