import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => {
    const state = { workspacePath: null, selectFile: vi.fn() }
    return sel(state)
  }),
}))
vi.mock('@/stores/ui', () => ({
  useUIStore: vi.fn((sel: (s: any) => any) => {
    const state = { closeSettings: vi.fn() }
    return sel(state)
  }),
}))
vi.mock('@/stores/knowledge', () => ({
  useKnowledgeStore: vi.fn(() => ({
    startIndex: vi.fn(),
    needsReindex: false,
    isIndexing: false,
  })),
}))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' '), isTauri: () => false }))
vi.mock('@/lib/knowledge-utils', () => ({
  classifyFileType: vi.fn(),
  filterKnowledgeItems: vi.fn(() => []),
}))
vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../knowledge/IndexStatusPanel', () => ({ IndexStatusPanel: () => <div>index-status</div> }))
vi.mock('../knowledge/KnowledgeSearchPreview', () => ({ KnowledgeSearchPreview: () => <div>search-preview</div> }))
vi.mock('../KnowledgeConfigPanel', () => ({ KnowledgeConfigPanel: () => <div>config-panel</div> }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { KnowledgeSection } from '../KnowledgeSection'

describe('KnowledgeSection', () => {
  it('renders the Knowledge Base title', () => {
    render(<KnowledgeSection />)
    expect(screen.getByText('Knowledge Base')).toBeTruthy()
  })

  it('shows workspace selection prompt when no workspace', () => {
    render(<KnowledgeSection />)
    expect(screen.getByText('Please select a workspace directory first')).toBeTruthy()
  })
})
