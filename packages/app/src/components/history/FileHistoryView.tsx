import { useEffect, useState, lazy, Suspense, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import type { HistoryEntry, HistoryProvider } from '@/lib/history/types'
import { CommitList } from './CommitList'

const LazyDiffRenderer = lazy(() => import('@/components/diff/DiffRenderer'))

// Heuristic: code-unit count, not byte count. Big-enough strings are slow
// regardless of encoding, so a code-unit ceiling is sufficient as a sanity guard.
const MAX_DIFF_CHARS = 256 * 1024
const NULL_SCAN_CHARS = 8192

interface FileHistoryViewProps {
  provider: HistoryProvider
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

export function FileHistoryView({ provider, filePath, isDark }: FileHistoryViewProps) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [selectedRef, setSelectedRef] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
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
    () => entries.find((e) => e.ref === selectedRef) ?? null,
    [entries, selectedRef],
  )

  const fetchInitial = useCallback(() => {
    setLoading(true)
    setListError(null)
    setBefore(null)
    setAfter(null)
    setDiffError(null)
    setLoadingDiff(false)
    return provider
      .list(null)
      .then((page) => {
        setEntries(page.entries)
        setCursor(page.nextCursor)
        setHasMore(page.nextCursor !== null)
        setSelectedRef(page.entries.length > 0 ? page.entries[0].ref : null)
        setLoading(false)
      })
      .catch((err: unknown) => {
        setListError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }, [provider])

  // (Re)load when target file / provider changes.
  useEffect(() => {
    setEntries([])
    setSelectedRef(null)
    setCursor(null)
    setBefore(null)
    setAfter(null)
    setListError(null)
    setDiffError(null)
    setHasMore(false)
    loadMoreGenRef.current++
    void fetchInitial()
  }, [fetchInitial])

  // Fetch diff for selected entry: selected content vs its parent's content.
  useEffect(() => {
    if (!selectedRef || !selectedEntry) {
      setBefore(null)
      setAfter(null)
      setDiffError(null)
      return
    }

    let cancelled = false
    setLoadingDiff(true)
    setDiffError(null)

    const afterPromise = provider.getContent(selectedEntry.ref)
    const beforePromise: Promise<string | null> =
      selectedEntry.parentRef === ''
        ? Promise.resolve('')
        : provider.getContent(selectedEntry.parentRef)

    Promise.all([beforePromise, afterPromise])
      .then(([b, a]) => {
        if (cancelled) return
        if (a === null) {
          setDiffError(
            t('history.loadCommitContentFailed', {
              sha: selectedRef.slice(0, 7),
              defaultValue: 'Unable to load content for this version ({{sha}})',
            }),
          )
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
  }, [selectedRef, selectedEntry, provider, t])

  const handleLoadMore = useCallback(() => {
    if (loadingMore) return
    const gen = ++loadMoreGenRef.current
    setLoadingMore(true)
    provider
      .list(cursor)
      .then((page) => {
        if (gen !== loadMoreGenRef.current) return
        setEntries((prev) => [...prev, ...page.entries])
        setCursor(page.nextCursor)
        setHasMore(page.nextCursor !== null)
        setLoadingMore(false)
      })
      .catch((err: unknown) => {
        if (gen !== loadMoreGenRef.current) return
        setListError(err instanceof Error ? err.message : String(err))
        setLoadingMore(false)
      })
  }, [provider, cursor, loadingMore])

  const showEmpty = !loading && !listError && entries.length === 0
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
              {t('common.retry', 'Retry')}
            </button>
          </div>
        ) : (
          <CommitList
            entries={entries}
            selectedRef={selectedRef}
            onSelect={setSelectedRef}
            onLoadMore={handleLoadMore}
            hasMore={hasMore}
            loadingMore={loadingMore}
          />
        )}
      </div>
      <div className="flex-1 overflow-hidden">
        {showEmpty ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            {t('history.noFileHistory', 'This file has no version history yet')}
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
            {t('history.diffSkippedTooLarge', 'File is too large or binary, skipping diff')}
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
