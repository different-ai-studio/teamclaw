import { useCallback, useEffect, useRef, useState } from "react"
import { X, ChevronUp, ChevronDown } from "lucide-react"
import { isTauri } from "@/lib/utils"

interface FindInPageBarProps {
  label: string
  onClose: () => void
}

export function FindInPageBar({ label, onClose }: FindInPageBarProps) {
  const [query, setQuery] = useState("")
  const [found, setFound] = useState<boolean | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // Clear find highlights on unmount
  useEffect(() => {
    return () => {
      if (!isTauri()) return
      import("@tauri-apps/api/core").then(({ invoke }) => {
        invoke("webview_clear_find", { label }).catch(() => {})
      })
    }
  }, [label])

  const doFind = useCallback(async (forward: boolean) => {
    if (!query || !isTauri()) return
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      const result = await invoke<boolean>("webview_find_in_page", {
        label,
        query,
        forward,
      })
      setFound(result)
    } catch {
      setFound(false)
    }
  }, [label, query])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      doFind(!e.shiftKey)
    }
  }, [doFind])

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 border-b bg-muted/30 shrink-0 pointer-events-auto">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setFound(null) }}
        onKeyDown={handleKeyDown}
        placeholder="Find in page..."
        className="flex-1 min-w-0 px-2 py-0.5 text-xs rounded border bg-background/80 outline-none focus:ring-1 focus:ring-primary"
      />
      {found === false && query && (
        <span className="text-xs text-destructive shrink-0">No matches</span>
      )}
      <button
        onClick={() => doFind(false)}
        title="Previous (Shift+Enter)"
        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => doFind(true)}
        title="Next (Enter)"
        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onClose}
        title="Close (Escape)"
        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
