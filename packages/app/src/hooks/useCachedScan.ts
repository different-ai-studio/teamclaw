import { useRef, useState, useEffect } from 'react'

/**
 * Cache the result of an async scan keyed by workspace path.
 * Re-scans only when workspace changes; returns cached results otherwise.
 * scanFn is stored in a ref to avoid dependency-induced re-scans.
 */
export function useCachedScan<T>(
  workspace: string | null,
  scanFn: (workspace: string) => Promise<T[]>,
  fallback: T[] = [],
): T[] {
  const cachedWorkspace = useRef<string | null>(null)
  const cachedEntries = useRef<T[]>(fallback)
  const scanFnRef = useRef(scanFn)
  scanFnRef.current = scanFn
  const [entries, setEntries] = useState<T[]>(fallback)

  useEffect(() => {
    if (!workspace) {
      setEntries(fallback)
      return
    }
    if (workspace === cachedWorkspace.current) {
      setEntries(cachedEntries.current)
      return
    }
    let cancelled = false
    cachedWorkspace.current = workspace
    scanFnRef.current(workspace).then((result) => {
      if (cancelled) return
      cachedEntries.current = result
      setEntries(result)
    })
    return () => { cancelled = true }
  }, [workspace])

  return entries
}
