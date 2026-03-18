import { useState, useEffect, useCallback } from 'react'
import { isTauri } from '@/lib/utils'
import { useUIStore } from '@/stores/ui'

let invoke: typeof import('@tauri-apps/api/core').invoke
let getCurrentWindow: typeof import('@tauri-apps/api/window').getCurrentWindow

if (isTauri()) {
  import('@tauri-apps/api/core').then((m) => { invoke = m.invoke })
  import('@tauri-apps/api/window').then((m) => { getCurrentWindow = m.getCurrentWindow })
}

export function useSpotlight() {
  const spotlightMode = useUIStore((s) => s.spotlightMode)
  const [pinned, setPinned] = useState(false)

  const togglePin = useCallback(async () => {
    const newPinned = !pinned
    setPinned(newPinned)
    if (isTauri() && invoke) {
      await invoke('set_spotlight_pin', { pinned: newPinned })
    }
  }, [pinned])

  const expandToMain = useCallback(async () => {
    if (isTauri() && invoke) {
      await invoke('expand_to_main')
    }
  }, [])

  // Hide on blur when unpinned (only in spotlight mode)
  useEffect(() => {
    if (!isTauri() || pinned || !spotlightMode) return
    let cancelled = false
    let cleanup: (() => void) | undefined
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (cancelled) return
      const win = getCurrentWindow()
      win.onFocusChanged(({ payload: focused }) => {
        if (!focused) win.hide()
      }).then((fn) => {
        if (cancelled) fn()
        else cleanup = fn
      })
    })
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [pinned, spotlightMode])

  // Escape to hide (only in spotlight mode)
  useEffect(() => {
    if (!spotlightMode) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTauri() && getCurrentWindow) {
        getCurrentWindow().hide()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [spotlightMode])

  return { pinned, togglePin, expandToMain }
}
