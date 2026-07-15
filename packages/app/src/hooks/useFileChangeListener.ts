import { useEffect, useRef } from 'react'
import { isTauri } from '@/lib/utils'

type FileChangeEvent = {
  payload: { path: string; kind: string }
}

/**
 * Listen for Tauri file-change events with built-in debouncing.
 * No-op in web (non-Tauri) environments.
 *
 * @param handler  Called with the file-change event after debounce
 * @param delay    Debounce delay in ms (default 500)
 * @param enabled  Whether to listen (default true) — pass false to conditionally disable
 */
export function useFileChangeListener(
  handler: (event: FileChangeEvent) => void,
  delay: number = 500,
  enabled: boolean = true,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!enabled || !isTauri()) return

    let timer: ReturnType<typeof setTimeout>
    let unlisten: (() => void) | undefined

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ path: string; kind: string }>('file-change', (event) => {
        clearTimeout(timer)
        timer = setTimeout(() => handlerRef.current(event), delay)
      }).then((fn) => {
        unlisten = fn
      })
    })

    return () => {
      clearTimeout(timer)
      unlisten?.()
    }
  }, [delay, enabled])
}
