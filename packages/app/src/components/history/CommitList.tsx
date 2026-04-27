import { Loader2 } from 'lucide-react'
import type { GitLogEntry } from '@/lib/git/types'

interface CommitListProps {
  commits: GitLogEntry[]
  selectedSha: string | null
  onSelect: (sha: string) => void
  onLoadMore: () => void
  hasMore: boolean
  loadingMore: boolean
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const diffSec = Math.round((t - Date.now()) / 1000)
  const abs = Math.abs(diffSec)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 60) return rtf.format(diffSec, 'second')
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  return rtf.format(Math.round(diffSec / 86400), 'day')
}

export function CommitList({
  commits,
  selectedSha,
  onSelect,
  onLoadMore,
  hasMore,
  loadingMore,
}: CommitListProps) {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {commits.map((c) => {
        const active = c.sha === selectedSha
        return (
          <button
            key={c.sha}
            type="button"
            onClick={() => onSelect(c.sha)}
            className={`text-left px-3 py-2 border-b border-border/50 transition-colors ${
              active ? 'text-primary bg-primary/10' : 'hover:bg-muted'
            }`}
          >
            <div className="text-xs text-muted-foreground truncate">
              {formatRelative(c.isoTime)} · {c.author}
            </div>
            <div className="text-sm truncate">{c.subject}</div>
          </button>
        )
      })}
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="px-3 py-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          {loadingMore ? <Loader2 className="h-3 w-3 animate-spin inline" /> : '加载更多'}
        </button>
      )}
    </div>
  )
}
