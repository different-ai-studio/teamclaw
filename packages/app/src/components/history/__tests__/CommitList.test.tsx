import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CommitList } from '../CommitList'
import type { HistoryEntry } from '@/lib/history/types'

vi.mock('react-i18next', () => ({
  useTranslation: (() => {
    const t = (key: string, fallback?: string) =>
      ({
        'sidebar.loadMore': '加载更多',
      })[key] ?? fallback ?? key
    return () => ({
      i18n: { language: 'zh-CN' },
      t,
    })
  })(),
}))

const sample: HistoryEntry[] = [
  {
    ref: 'a'.repeat(40),
    parentRef: 'b'.repeat(40),
    label: 'a'.repeat(7),
    author: 'Alice',
    timestamp: '2026-04-27T10:00:00+00:00',
    message: 'second',
  },
  {
    ref: 'b'.repeat(40),
    parentRef: '',
    label: 'b'.repeat(7),
    author: 'Bob',
    timestamp: '2026-04-26T10:00:00+00:00',
    message: 'first',
  },
]

describe('CommitList', () => {
  it('renders a row per entry with message and author', () => {
    render(
      <CommitList
        entries={sample}
        selectedRef={null}
        onSelect={() => {}}
        onLoadMore={() => {}}
        hasMore={false}
        loadingMore={false}
      />,
    )
    expect(screen.getByText('second')).toBeDefined()
    expect(screen.getByText('first')).toBeDefined()
    expect(screen.getByText(/Alice/)).toBeDefined()
    expect(screen.getByText(/Bob/)).toBeDefined()
  })

  it('calls onSelect with the row ref when clicked', () => {
    const onSelect = vi.fn()
    render(
      <CommitList
        entries={sample}
        selectedRef={null}
        onSelect={onSelect}
        onLoadMore={() => {}}
        hasMore={false}
        loadingMore={false}
      />,
    )
    fireEvent.click(screen.getByText('first'))
    expect(onSelect).toHaveBeenCalledWith(sample[1].ref)
  })

  it('renders the "load more" button when hasMore=true and triggers onLoadMore', () => {
    const onLoadMore = vi.fn()
    render(
      <CommitList
        entries={sample}
        selectedRef={null}
        onSelect={() => {}}
        onLoadMore={onLoadMore}
        hasMore={true}
        loadingMore={false}
      />,
    )
    const btn = screen.getByRole('button', { name: '加载更多' })
    fireEvent.click(btn)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('hides the "load more" button when hasMore=false', () => {
    render(
      <CommitList
        entries={sample}
        selectedRef={null}
        onSelect={() => {}}
        onLoadMore={() => {}}
        hasMore={false}
        loadingMore={false}
      />,
    )
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
  })

  it('disables the "load more" button while loadingMore', () => {
    render(
      <CommitList
        entries={sample}
        selectedRef={null}
        onSelect={() => {}}
        onLoadMore={() => {}}
        hasMore={true}
        loadingMore={true}
      />,
    )
    const btn = screen.getByRole('button', { name: '' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})
