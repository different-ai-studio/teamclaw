import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { HistoryProvider } from '@/lib/history/types'
import { FileHistoryView } from '../FileHistoryView'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: unknown) =>
      typeof d === 'string' ? d : (d as { defaultValue?: string })?.defaultValue ?? _k,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@/components/diff/DiffRenderer', () => ({
  default: ({ before, after }: { before: string; after: string }) => (
    <div data-testid="diff">{`${before}=>${after}`}</div>
  ),
}))

function makeProvider(over: Partial<HistoryProvider> = {}): HistoryProvider {
  return {
    list: vi.fn().mockResolvedValue({
      entries: [
        { ref: 'h2', parentRef: 'h1', label: 'v2', author: 'Alice', timestamp: 't2', message: 'edit' },
        { ref: 'h1', parentRef: '', label: 'v1', author: 'Bob', timestamp: 't1', message: 'init' },
      ],
      nextCursor: null,
    }),
    getContent: vi.fn(async (ref: string) => (ref === '' ? '' : `body-${ref}`)),
    ...over,
  }
}

describe('FileHistoryView', () => {
  it('renders the version list and diffs the first entry vs its parent', async () => {
    const provider = makeProvider()
    render(<FileHistoryView provider={provider} filePath="/ws/teamclaw-team/a.md" isDark={false} />)

    expect(await screen.findByText('edit')).toBeInTheDocument()
    expect(screen.getByText('init')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByTestId('diff')).toHaveTextContent('body-h1=>body-h2')
    })
  })

  it('initial-revision selection uses empty before', async () => {
    const provider = makeProvider()
    render(<FileHistoryView provider={provider} filePath="/ws/teamclaw-team/a.md" isDark={false} />)
    fireEvent.click(await screen.findByText('init'))
    await waitFor(() => {
      expect(screen.getByTestId('diff')).toHaveTextContent('=>body-h1')
    })
  })

  it('shows a retryable error when list() rejects', async () => {
    const provider = makeProvider({ list: vi.fn().mockRejectedValue(new Error('boom')) })
    render(<FileHistoryView provider={provider} filePath="/ws/teamclaw-team/a.md" isDark={false} />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.getByText('Retry')).toBeInTheDocument()
  })
})
