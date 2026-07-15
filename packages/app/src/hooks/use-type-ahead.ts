import { useEffect, useRef } from 'react'

interface UseTypeAheadOptions {
  enabled: boolean
  /** Items in display order. Searched in order; first prefix match wins. */
  items: ReadonlyArray<{ id: string; label: string }>
  onMatch: (id: string) => void
  /** Buffer is cleared after this many ms of keystroke inactivity. */
  resetMs?: number
}

/**
 * Native-list-style type-ahead. While `enabled`, letter / digit / CJK
 * keystrokes (with no input focused, no modifier held) accumulate into a
 * buffer and the first item whose label starts with that buffer is
 * selected. The buffer clears after `resetMs` of inactivity.
 *
 * Mirrors the behavior of NSTableView / Finder on macOS — pressing "te" in
 * a session list jumps to the first session whose title begins with "te".
 */
export function useTypeAhead({
  enabled,
  items,
  onMatch,
  resetMs = 600,
}: UseTypeAheadOptions): void {
  const bufferRef = useRef('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track items + callback via refs so the listener doesn't re-attach on
  // every keystroke or list update.
  const itemsRef = useRef(items)
  const onMatchRef = useRef(onMatch)
  itemsRef.current = items
  onMatchRef.current = onMatch

  useEffect(() => {
    if (!enabled) return

    function isTypingTarget(el: EventTarget | null): boolean {
      const node = el as HTMLElement | null
      if (!node) return false
      const tag = node.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
      if (node.isContentEditable) return true
      return false
    }

    function handler(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      const k = e.key
      if (k.length !== 1) return
      // Letters / digits / CJK ideographs. Excludes punctuation and whitespace.
      if (!/[\p{L}\p{N}]/u.test(k)) return

      bufferRef.current += k.toLowerCase()
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        bufferRef.current = ''
      }, resetMs)

      const buf = bufferRef.current
      const match = itemsRef.current.find((it) =>
        it.label.toLowerCase().startsWith(buf),
      )
      if (match) {
        e.preventDefault()
        onMatchRef.current(match.id)
      }
    }

    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [enabled, resetMs])
}
