import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback: string) => fallback,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  isTauri: () => false,
}))

vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    X: (props: Record<string, unknown>) => React.createElement('span', props, 'X'),
  }
})

vi.mock('@/components/detail/SearchResults', () => ({
  SearchResults: () => React.createElement('div', { 'data-testid': 'search-results' }, 'SearchResults'),
}))

vi.mock('@/components/detail/FilePreview', () => ({
  FilePreview: () => React.createElement('div', { 'data-testid': 'file-preview' }, 'FilePreview'),
}))

vi.mock('@/components/detail/TerminalOutput', () => ({
  TerminalOutput: () => React.createElement('div', { 'data-testid': 'terminal-output' }, 'TerminalOutput'),
}))

vi.mock('@/components/detail/McpDetail', () => ({
  McpDetail: () => React.createElement('div', { 'data-testid': 'mcp-detail' }, 'McpDetail'),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DetailPanel', () => {
  it('returns null when content is null', async () => {
    const { DetailPanel } = await import('@/components/detail/DetailPanel')
    const { container } = render(React.createElement(DetailPanel, { content: null, onClose: vi.fn() }))
    expect(container.innerHTML).toBe('')
  })

  it('renders search results for type=search', async () => {
    const { DetailPanel } = await import('@/components/detail/DetailPanel')
    render(React.createElement(DetailPanel, {
      content: { type: 'search' as const, data: {} },
      onClose: vi.fn(),
    }))
    expect(screen.getByText('Search Results')).toBeDefined()
    expect(screen.getByTestId('search-results')).toBeDefined()
  })

  it('renders file preview for type=file', async () => {
    const { DetailPanel } = await import('@/components/detail/DetailPanel')
    render(React.createElement(DetailPanel, {
      content: { type: 'file' as const, data: {} },
      onClose: vi.fn(),
    }))
    expect(screen.getByText('File Preview')).toBeDefined()
    expect(screen.getByTestId('file-preview')).toBeDefined()
  })
})
