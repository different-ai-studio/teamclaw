import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ activeTab: 'shortcuts' }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ todos: [], sessionDiff: [] }),
}))

vi.mock('@/components/chat/SessionDiffPanel', () => ({
  SessionDiffPanel: () => React.createElement('div', { 'data-testid': 'session-diff' }),
}))

vi.mock('@/components/chat/SessionList', () => ({
  SessionList: () => React.createElement('div', { 'data-testid': 'session-list' }),
}))

vi.mock('@/components/workspace/FileBrowser', () => ({
  FileBrowser: () => React.createElement('div', { 'data-testid': 'file-browser' }),
}))

vi.mock('@/components/panel/ShortcutsPanel', () => ({
  ShortcutsPanel: () => React.createElement('div', { 'data-testid': 'shortcuts-panel' }),
}))

vi.mock('@/components/knowledge/KnowledgeBrowser', () => ({
  KnowledgeBrowser: () => React.createElement('div', { 'data-testid': 'knowledge-browser' }),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RightPanel', () => {
  it('renders shortcuts tab from store', async () => {
    const { RightPanel } = await import('@/components/panel/RightPanel')
    render(React.createElement(RightPanel))
    expect(screen.getByTestId('shortcuts-panel')).toBeDefined()
  })

  it('renders diff tab when defaultTab=diff', async () => {
    const { RightPanel } = await import('@/components/panel/RightPanel')
    render(React.createElement(RightPanel, { defaultTab: 'diff' }))
    expect(screen.getByText('No changes yet')).toBeDefined()
  })

  it('renders shortcuts panel when defaultTab=shortcuts', async () => {
    const { RightPanel } = await import('@/components/panel/RightPanel')
    render(React.createElement(RightPanel, { defaultTab: 'shortcuts' }))
    expect(screen.getByTestId('shortcuts-panel')).toBeDefined()
  })
})
