import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { GitLogEntry } from '@/lib/git/types'

const logFileMock = vi.fn()
const showFileMock = vi.fn()

vi.mock('@/lib/git/manager', () => ({
  gitManager: {
    logFile: (...args: unknown[]) => logFileMock(...args),
    showFile: (...args: unknown[]) => showFileMock(...args),
  },
}))

vi.mock('@/components/diff/DiffRenderer', () => ({
  default: ({ before, after, filePath }: { before: string; after: string; filePath: string }) => (
    <div data-testid="diff-renderer" data-before={before} data-after={after} data-filepath={filePath} />
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: (() => {
    const translations: Record<string, string> = {
      'common.retry': '重试',
      'history.noFileHistory': '该文件还没有提交历史',
      'history.diffSkippedTooLarge': '文件过大或为二进制，跳过 diff',
      'sidebar.loadMore': '加载更多',
    }
    const t = (key: string, options?: string | { sha?: string; defaultValue?: string }) => {
      if (key === 'history.loadCommitContentFailed') {
        const sha = typeof options === 'object' ? options.sha : undefined
        return `无法加载该提交的内容 (${sha ?? ''})`
      }
      return translations[key] ?? (typeof options === 'string' ? options : key)
    }
    return () => ({
      i18n: { language: 'zh-CN' },
      t,
    })
  })(),
}))

import { FileHistoryView } from '../FileHistoryView'

const initial: GitLogEntry = {
  sha: 'newsha'.padEnd(40, '0'),
  parentSha: 'oldsha'.padEnd(40, '0'),
  author: 'Alice',
  isoTime: '2026-04-27T10:00:00+00:00',
  subject: 'second',
}
const previous: GitLogEntry = {
  sha: 'oldsha'.padEnd(40, '0'),
  parentSha: '',
  author: 'Bob',
  isoTime: '2026-04-26T10:00:00+00:00',
  subject: 'first',
}

describe('FileHistoryView', () => {
  beforeEach(() => {
    logFileMock.mockReset()
    showFileMock.mockReset()
  })

  it('loads commits, auto-selects the first, and renders its diff', async () => {
    logFileMock.mockResolvedValueOnce([initial, previous])
    showFileMock.mockImplementation((_path: string, _file: string, ref: string) => {
      if (ref === initial.sha) return Promise.resolve('AFTER')
      if (ref === initial.parentSha) return Promise.resolve('BEFORE')
      return Promise.resolve(null)
    })

    render(
      <FileHistoryView
        repoPath="/repo"
        relativePath="a.txt"
        filePath="/repo/a.txt"
        isDark={false}
      />,
    )

    await waitFor(() => expect(logFileMock).toHaveBeenCalledWith('/repo', 'a.txt', 50, 0))
    await waitFor(() => {
      const node = screen.getByTestId('diff-renderer')
      expect(node.getAttribute('data-before')).toBe('BEFORE')
      expect(node.getAttribute('data-after')).toBe('AFTER')
      expect(node.getAttribute('data-filepath')).toBe('/repo/a.txt')
    })
  })

  it('skips the parent fetch for the initial commit and passes empty before', async () => {
    logFileMock.mockResolvedValueOnce([previous]) // only the first commit ever
    showFileMock.mockImplementation((_p: string, _f: string, ref: string) => {
      if (ref === previous.sha) return Promise.resolve('AFTER')
      throw new Error(`unexpected ref: ${ref}`)
    })

    render(
      <FileHistoryView
        repoPath="/repo"
        relativePath="a.txt"
        filePath="/repo/a.txt"
        isDark={false}
      />,
    )

    await waitFor(() => {
      const node = screen.getByTestId('diff-renderer')
      expect(node.getAttribute('data-before')).toBe('')
      expect(node.getAttribute('data-after')).toBe('AFTER')
    })
    expect(showFileMock).toHaveBeenCalledTimes(1)
  })

  it('renders empty state when commit list is empty', async () => {
    logFileMock.mockResolvedValueOnce([])

    render(
      <FileHistoryView
        repoPath="/repo"
        relativePath="ghost.txt"
        filePath="/repo/ghost.txt"
        isDark={false}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('该文件还没有提交历史')).toBeDefined()
    })
    expect(showFileMock).not.toHaveBeenCalled()
  })

  it('renders a retry banner when logFile rejects, and retries on click', async () => {
    logFileMock.mockRejectedValueOnce(new Error('git not available'))
    logFileMock.mockResolvedValueOnce([initial])
    showFileMock.mockResolvedValue('CONTENT')

    render(
      <FileHistoryView
        repoPath="/repo"
        relativePath="a.txt"
        filePath="/repo/a.txt"
        isDark={false}
      />,
    )

    await waitFor(() => expect(screen.getByText(/git not available/)).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(logFileMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('diff-renderer')).toBeDefined())
  })

  it('renders a diff error placeholder when showFile fails for selected commit', async () => {
    logFileMock.mockResolvedValueOnce([initial])
    showFileMock.mockResolvedValue(null) // both before & after resolve to null

    render(
      <FileHistoryView
        repoPath="/repo"
        relativePath="a.txt"
        filePath="/repo/a.txt"
        isDark={false}
      />,
    )

    await waitFor(() => expect(screen.getByText(/无法加载该提交的内容/)).toBeDefined())
  })

  it('appends results when "load more" is clicked', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      ...initial,
      sha: `s1-${String(i).padStart(3, '0')}`.padEnd(40, '0'),
      subject: `c1-${i}`,
    }))
    const page2 = [
      { ...previous, sha: 'next-page'.padEnd(40, '0'), subject: 'c2-0' },
    ]
    logFileMock.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)
    showFileMock.mockResolvedValue('X')

    render(
      <FileHistoryView
        repoPath="/repo"
        relativePath="a.txt"
        filePath="/repo/a.txt"
        isDark={false}
      />,
    )

    await waitFor(() => expect(screen.getByText('c1-0')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await waitFor(() => expect(logFileMock).toHaveBeenLastCalledWith('/repo', 'a.txt', 50, 50))
    await waitFor(() => expect(screen.getByText('c2-0')).toBeDefined())
  })

  it('resets state and reloads when relativePath changes', async () => {
    logFileMock.mockResolvedValueOnce([initial])
    showFileMock.mockResolvedValue('CONTENT')

    const { rerender } = render(
      <FileHistoryView
        repoPath="/repo"
        relativePath="a.txt"
        filePath="/repo/a.txt"
        isDark={false}
      />,
    )
    await waitFor(() => expect(logFileMock).toHaveBeenCalledWith('/repo', 'a.txt', 50, 0))

    logFileMock.mockResolvedValueOnce([previous])
    rerender(
      <FileHistoryView
        repoPath="/repo"
        relativePath="b.txt"
        filePath="/repo/b.txt"
        isDark={false}
      />,
    )
    await waitFor(() => expect(logFileMock).toHaveBeenLastCalledWith('/repo', 'b.txt', 50, 0))
  })
})
