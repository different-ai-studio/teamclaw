/** A single revision in a file's history, source-agnostic. */
export interface HistoryEntry {
  /** Opaque id to fetch this revision's content (git sha / oss contentHash). */
  ref: string
  /** Parent revision's ref. '' means no parent (initial revision). */
  parentRef: string
  /** Short label for the list (sha[:7] / "v{n}"). */
  label: string
  author: string | null
  /** ISO 8601 timestamp. */
  timestamp: string
  message: string | null
}

/** One page of history entries plus an opaque cursor for the next page. */
export interface HistoryPage {
  entries: HistoryEntry[]
  /** Opaque cursor for the next page; null means no more. */
  nextCursor: string | null
}

/** Source-agnostic file history backend (git or OSS). */
export interface HistoryProvider {
  /** Fetch one page. Pass null for the first page. */
  list(cursor: string | null): Promise<HistoryPage>
  /** Fetch a revision's full content. '' = empty, null = fetch failed. */
  getContent(ref: string): Promise<string | null>
}
