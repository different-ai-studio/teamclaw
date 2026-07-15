import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { IndexStatusPanel } from '../IndexStatusPanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      // i18next t() can be called as t(key, defaultValue) or t(key, { count: n })
      if (typeof fallback === 'string') return fallback
      return key
    },
  }),
}))

const mockLoadIndexStatus = vi.fn()
const mockStartIndex = vi.fn()

let mockStoreState: Record<string, unknown> = {}

vi.mock('@/stores/knowledge', () => ({
  useKnowledgeStore: (selector?: (s: unknown) => unknown) => {
    if (selector) return selector(mockStoreState)
    return mockStoreState
  },
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

vi.mock('@/lib/knowledge-utils', () => ({
  formatTimeAgo: (iso: string | undefined) => iso ? 'some time ago' : 'never',
}))

describe('IndexStatusPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStoreState = {
      indexStatus: null,
      isIndexing: false,
      indexProgress: null,
      loadIndexStatus: mockLoadIndexStatus,
      startIndex: mockStartIndex,
    }
  })

  it('shows spinner when indexStatus is null', () => {
    const { container } = render(<IndexStatusPanel />)
    expect(container.querySelector('svg.animate-spin')).toBeTruthy()
  })

  it('renders stats grid when indexStatus is present', () => {
    mockStoreState.indexStatus = {
      totalDocuments: 10,
      totalChunks: 50,
      bm25Documents: 10,
      lastIndexed: '2025-01-01T00:00:00Z',
    }
    const { container } = render(<IndexStatusPanel />)
    // Stats should display the numbers somewhere in the rendered output
    const text = container.textContent || ''
    expect(text).toContain('10')
    expect(text).toContain('50')
  })

  it('shows BM25 needs-reindex warning when bm25 is 0 but documents > 0', () => {
    mockStoreState.indexStatus = {
      totalDocuments: 5,
      totalChunks: 20,
      bm25Documents: 0,
      lastIndexed: '2025-01-01T00:00:00Z',
    }
    render(<IndexStatusPanel />)
    expect(screen.getByText('knowledge.stats.needsReindex')).toBeTruthy()
  })

  it('does not show needs-reindex when both are 0', () => {
    mockStoreState.indexStatus = {
      totalDocuments: 0,
      totalChunks: 0,
      bm25Documents: 0,
    }
    render(<IndexStatusPanel />)
    expect(screen.queryByText('knowledge.stats.needsReindex')).toBeNull()
  })

  it('shows progress details when indexProgress is present', () => {
    mockStoreState.indexStatus = {
      totalDocuments: 3,
      totalChunks: 15,
      bm25Documents: 3,
    }
    mockStoreState.indexProgress = {
      indexed: 3,
      skipped: 1,
      failed: 0,
      totalChunks: 15,
      durationMs: 200,
    }
    const { container } = render(<IndexStatusPanel />)
    // The t() mock returns the fallback string (2nd arg)
    const text = container.textContent || ''
    expect(text).toContain('Indexed: {{count}} documents')
  })

  it('shows "Indexing..." button text when isIndexing is true', () => {
    mockStoreState.indexStatus = {
      totalDocuments: 1,
      totalChunks: 5,
      bm25Documents: 1,
    }
    mockStoreState.isIndexing = true
    render(<IndexStatusPanel />)
    expect(screen.getByText('Indexing...')).toBeTruthy()
  })

  it('shows "Reindex" button text when not indexing', () => {
    mockStoreState.indexStatus = {
      totalDocuments: 1,
      totalChunks: 5,
      bm25Documents: 1,
    }
    render(<IndexStatusPanel />)
    expect(screen.getByText('Reindex')).toBeTruthy()
  })

  it('calls loadIndexStatus on mount', () => {
    render(<IndexStatusPanel />)
    expect(mockLoadIndexStatus).toHaveBeenCalled()
  })
})
