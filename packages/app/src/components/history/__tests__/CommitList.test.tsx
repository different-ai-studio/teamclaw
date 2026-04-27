import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CommitList } from '../CommitList'
import type { GitLogEntry } from '@/lib/git/types'

const sample: GitLogEntry[] = [
  {
    sha: 'a'.repeat(40),
    parentSha: 'b'.repeat(40),
    author: 'Alice',
    isoTime: '2026-04-27T10:00:00+00:00',
    subject: 'second',
  },
  {
    sha: 'b'.repeat(40),
    parentSha: '',
    author: 'Bob',
    isoTime: '2026-04-26T10:00:00+00:00',
    subject: 'first',
  },
]

describe('CommitList', () => {
  it('renders a row per commit with subject and author', () => {
    render(
      <CommitList
        commits={sample}
        selectedSha={null}
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

  it('calls onSelect with the row sha when clicked', () => {
    const onSelect = vi.fn()
    render(
      <CommitList
        commits={sample}
        selectedSha={null}
        onSelect={onSelect}
        onLoadMore={() => {}}
        hasMore={false}
        loadingMore={false}
      />,
    )
    fireEvent.click(screen.getByText('first'))
    expect(onSelect).toHaveBeenCalledWith(sample[1].sha)
  })

  it('renders the "load more" button when hasMore=true and triggers onLoadMore', () => {
    const onLoadMore = vi.fn()
    render(
      <CommitList
        commits={sample}
        selectedSha={null}
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
        commits={sample}
        selectedSha={null}
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
        commits={sample}
        selectedSha={null}
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
