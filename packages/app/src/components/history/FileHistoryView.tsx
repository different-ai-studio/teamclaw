import { useEffect, useState, lazy, Suspense, useCallback, useMemo, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { gitManager } from '@/lib/git/manager'
import type { GitLogEntry } from '@/lib/git/types'
import { CommitList } from './CommitList'

const LazyDiffRenderer = lazy(() => import('@/components/diff/DiffRenderer'))

const PAGE_SIZE = 50
// Heuristic: code-unit count, not byte count. Big-enough strings are slow
// regardless of encoding, so a code-unit ceiling is sufficient as a sanity guard.
const MAX_DIFF_CHARS = 256 * 1024
const NULL_SCAN_CHARS = 8192

interface FileHistoryViewProps {
  repoPath: string
  relativePath: string
  filePath: string
  isDark: boolean
}

function isBinaryOrTooLarge(text: string): boolean {
  if (text.length > MAX_DIFF_CHARS) return true
  const sample = text.slice(0, NULL_SCAN_CHARS)
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0) return true
  }
  return false
}

export function FileHistoryView({
  repoPath,
  relativePath,
  filePath,
  isDark,
}: FileHistoryViewProps) {
  const [commits, setCommits] = useState<GitLogEntry[]>([])
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [before, setBefore] = useState<string | null>(null)
  const [after, setAfter] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)

  const loadMoreGenRef = useRef(0)

  const selectedEntry = useMemo(
    () => commits.find((c) => c.sha === selectedSha) ?? null,
    [commits, selectedSha],
  )

  const fetchInitial = useCallback(() => {
    setLoading(true)
    setListError(null)
    setBefore(null)
    setAfter(null)
    setDiffError(null)
    setLoadingDiff(false)
    return gitManager
      .logFile(repoPath, relativePath, PAGE_SIZE, 0)
      .then((entries) => {
        setCommits(entries)
        setHasMore(entries.length === PAGE_SIZE)
        setSelectedSha(entries.length > 0 ? entries[0].sha : null)
        setLoading(false)
      })
      .catch((err: unknown) => {
        setListError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }, [repoPath, relativePath])

  // (Re)load when target file changes.
  useEffect(() => {
    setCommits([])
    setSelectedSha(null)
    setBefore(null)
    setAfter(null)
    setListError(null)
    setDiffError(null)
    setHasMore(false)
    loadMoreGenRef.current++
    void fetchInitial()
  }, [fetchInitial])

  // Fetch diff for selected commit.
  useEffect(() => {
    if (!selectedSha || !selectedEntry) {
      setBefore(null)
      setAfter(null)
      setDiffError(null)
      return
    }

    let cancelled = false
    setLoadingDiff(true)
    setDiffError(null)

    const afterPromise = gitManager.showFile(repoPath, relativePath, selectedSha)
    const beforePromise: Promise<string | null> =
      selectedEntry.parentSha === ''
        ? Promise.resolve('')
        : gitManager.showFile(repoPath, relativePath, selectedEntry.parentSha)

    Promise.all([beforePromise, afterPromise])
      .then(([b, a]) => {
        if (cancelled) return
        if (a === null) {
          setDiffError(`无法加载该提交的内容 (${selectedSha.slice(0, 7)})`)
          setBefore(null)
          setAfter(null)
        } else {
          setBefore(b ?? '')
          setAfter(a)
        }
        setLoadingDiff(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setDiffError(err instanceof Error ? err.message : String(err))
        setLoadingDiff(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedSha, selectedEntry, repoPath, relativePath])

  const handleLoadMore = useCallback(() => {
    if (loadingMore) return
    const gen = ++loadMoreGenRef.current
    setLoadingMore(true)
    gitManager
      .logFile(repoPath, relativePath, PAGE_SIZE, commits.length)
      .then((entries) => {
        if (gen !== loadMoreGenRef.current) return
        setCommits((prev) => [...prev, ...entries])
        setHasMore(entries.length === PAGE_SIZE)
        setLoadingMore(false)
      })
      .catch((err: unknown) => {
        if (gen !== loadMoreGenRef.current) return
        setListError(err instanceof Error ? err.message : String(err))
        setLoadingMore(false)
      })
  }, [repoPath, relativePath, commits.length, loadingMore])

  const showEmpty = !loading && !listError && commits.length === 0
  const beforeTooLarge = before !== null && isBinaryOrTooLarge(before)
  const afterTooLarge = after !== null && isBinaryOrTooLarge(after)
  const showSizeGuard = afterTooLarge || beforeTooLarge

  return (
    <div className="flex h-full">
      <div className="w-[30%] min-w-[260px] flex flex-col border-r border-border">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : listError ? (
          <div className="p-3 text-xs text-red-500">
            {listError}
            <button type="button" onClick={fetchInitial} className="ml-2 underline">
              重试
            </button>
          </div>
        ) : (
          <CommitList
            commits={commits}
            selectedSha={selectedSha}
            onSelect={setSelectedSha}
            onLoadMore={handleLoadMore}
            hasMore={hasMore}
            loadingMore={loadingMore}
          />
        )}
      </div>
      <div className="flex-1 overflow-hidden">
        {showEmpty ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            该文件还没有提交历史
          </div>
        ) : loadingDiff ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : diffError ? (
          <div className="flex items-center justify-center h-full text-sm text-red-500">
            {diffError}
          </div>
        ) : showSizeGuard ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            文件过大或为二进制，跳过 diff
          </div>
        ) : after !== null ? (
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <LazyDiffRenderer
              before={before ?? ''}
              after={after}
              filePath={filePath}
              isDark={isDark}
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  )
}

export default FileHistoryView
