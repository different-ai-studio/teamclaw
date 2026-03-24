import * as React from "react"
import { File, Folder, Loader2 } from "lucide-react"
import { useWorkspaceStore } from "@/stores/workspace"
import { useTeamModeStore } from "@/stores/team-mode"
import { isTauri } from "@/lib/utils"
import { cn } from "@/lib/utils"

interface FileMentionPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  searchQuery: string
  onSearchChange: (query: string) => void
  onSelect: (relativePath: string) => void
}

const ALWAYS_IGNORED_NAMES = new Set([
  "node_modules", ".git", ".DS_Store", "dist", "build", ".next",
  "__pycache__", ".cache", ".turbo", "target", ".idea", ".vscode",
  ".ruff_cache",
])

const DEV_ONLY_NAMES = new Set([".teamclaw", ".opencode"])

function isIgnoredName(name: string): boolean {
  if (useTeamModeStore.getState().devUnlocked) return false
  if (ALWAYS_IGNORED_NAMES.has(name)) return true
  if (DEV_ONLY_NAMES.has(name)) return true
  return false
}

interface FlatEntry {
  name: string
  relPath: string
  type: "file" | "directory"
  depth: number
}

// Module-level cache so re-opening the popover is instant
let cachedWorkspace: string | null = null
let cachedEntries: FlatEntry[] = []

function getRelativePath(fullPath: string, workspacePath: string): string {
  if (fullPath.startsWith(workspacePath)) {
    const rel = fullPath.slice(workspacePath.length)
    return rel.startsWith("/") ? rel.slice(1) : rel
  }
  return fullPath
}

async function scanRecursive(
  dir: string,
  workspacePath: string,
  depth: number,
  maxDepth: number,
  result: FlatEntry[],
): Promise<void> {
  if (depth > maxDepth) return
  const { readDir } = await import("@tauri-apps/plugin-fs")
  let raw: Awaited<ReturnType<typeof readDir>>
  try {
    raw = await readDir(dir)
  } catch {
    return
  }

  const sorted = [...raw]
    .filter(e => e.name && !isIgnoredName(e.name))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return (a.name || "").localeCompare(b.name || "")
    })

  for (const entry of sorted) {
    if (!entry.name) continue
    const fullPath = `${dir}/${entry.name}`
    const relPath = getRelativePath(fullPath, workspacePath)
    result.push({
      name: entry.name,
      relPath,
      type: entry.isDirectory ? "directory" : "file",
      depth,
    })
    if (entry.isDirectory) {
      await scanRecursive(fullPath, workspacePath, depth + 1, maxDepth, result)
    }
  }
}

const MAX_DISPLAY = 80

export function FileMentionPopover({
  open,
  onOpenChange,
  searchQuery,
  onSelect,
}: FileMentionPopoverProps) {
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const [allEntries, setAllEntries] = React.useState<FlatEntry[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const [highlightedIndex, setHighlightedIndex] = React.useState(0)
  const listRef = React.useRef<HTMLDivElement>(null)

  // Recursively scan workspace on open
  React.useEffect(() => {
    if (!open || !workspacePath || !isTauri()) return

    // Use cache if workspace hasn't changed
    if (cachedWorkspace === workspacePath && cachedEntries.length > 0) {
      setAllEntries(cachedEntries)
      return
    }

    let cancelled = false
    setIsLoading(true)

    ;(async () => {
      const result: FlatEntry[] = []
      await scanRecursive(workspacePath, workspacePath, 0, 8, result)
      if (cancelled) return
      cachedWorkspace = workspacePath
      cachedEntries = result
      setAllEntries(result)
      setIsLoading(false)
    })()

    return () => { cancelled = true }
  }, [open, workspacePath])

  React.useEffect(() => {
    if (!open) {
      setHighlightedIndex(0)
    }
  }, [open])

  // Fuzzy-ish filtering: match against name and path
  const filteredEntries = React.useMemo(() => {
    if (!searchQuery) return allEntries.slice(0, MAX_DISPLAY)
    const lower = searchQuery.toLowerCase()
    const tokens = lower.split(/[\s/\\]+/).filter(Boolean)
    return allEntries
      .filter(e => {
        const target = e.relPath.toLowerCase()
        return tokens.every(t => target.includes(t))
      })
      .slice(0, MAX_DISPLAY)
  }, [allEntries, searchQuery])

  React.useEffect(() => {
    setHighlightedIndex(0)
  }, [filteredEntries])

  const handleSelect = React.useCallback((entry: FlatEntry) => {
    onSelect(entry.relPath)
    onOpenChange(false)
  }, [onSelect, onOpenChange])

  // Scroll highlighted item into view
  React.useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`)
    item?.scrollIntoView({ block: "nearest" })
  }, [highlightedIndex])

  // Keyboard navigation
  React.useEffect(() => {
    if (!open || filteredEntries.length === 0) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        e.stopPropagation()
        setHighlightedIndex(i => (i + 1) % filteredEntries.length)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        e.stopPropagation()
        setHighlightedIndex(i => (i - 1 + filteredEntries.length) % filteredEntries.length)
      } else if (e.key === "Enter" && !e.shiftKey) {
        if (e.isComposing || e.keyCode === 229) return
        e.preventDefault()
        e.stopPropagation()
        const entry = filteredEntries[highlightedIndex]
        if (entry) handleSelect(entry)
      }
    }

    document.addEventListener("keydown", onKeyDown, true)
    return () => document.removeEventListener("keydown", onKeyDown, true)
  }, [open, filteredEntries, highlightedIndex, handleSelect])

  if (!open) return null

  return (
    <div className="absolute bottom-full left-0 mb-2 w-96 rounded-lg border bg-popover shadow-lg z-50 animate-in fade-in slide-in-from-bottom-2 duration-200">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 text-[10px] text-muted-foreground border-b bg-muted/30">
        <span className="font-medium">Reference a file</span>
        {searchQuery && (
          <span className="text-[9px] text-primary font-mono">
            {searchQuery}
          </span>
        )}
        {!searchQuery && allEntries.length > 0 && (
          <span className="text-[9px]">
            {allEntries.length} items
          </span>
        )}
      </div>

      {/* File list */}
      <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Scanning workspace...
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            {searchQuery
              ? `No match for "${searchQuery}"`
              : "No files found"}
          </div>
        ) : (
          filteredEntries.map((entry, index) => (
            <div
              key={entry.relPath}
              data-index={index}
              onClick={() => handleSelect(entry)}
              onMouseEnter={() => setHighlightedIndex(index)}
              className={cn(
                "flex items-center gap-2 rounded-sm px-2 py-1.5 cursor-pointer select-none transition-colors",
                index === highlightedIndex
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent/50"
              )}
            >
              {entry.type === "directory" ? (
                <Folder className="h-4 w-4 text-blue-500 shrink-0" />
              ) : (
                <File className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <div className="flex-1 min-w-0 flex items-baseline gap-1.5">
                <span className="text-xs font-medium truncate shrink-0">
                  {entry.name}
                </span>
                {entry.relPath !== entry.name && (
                  <span className="text-[10px] text-muted-foreground/60 truncate">
                    {entry.relPath}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Hint bar */}
      <div className="flex items-center gap-3 px-3 py-1.5 text-[10px] text-muted-foreground/60 border-t">
        <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">↑↓</kbd> navigate</span>
        <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">↵</kbd> select</span>
        <span><kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">Esc</kbd> close</span>
      </div>
    </div>
  )
}

// Invalidate cache when workspace changes
export function invalidateFileMentionCache(): void {
  cachedWorkspace = null
  cachedEntries = []
}
