import { useEffect } from 'react'
import { isTauri } from '@/lib/utils'
import { useMCPStore } from '@/stores/mcp'

/**
 * Watch opencode.json for changes and sync MCP config to sidecar runtime.
 * Covers both Settings UI edits and external editor (VSCode etc.) edits.
 */
export function useMCPFileWatcher(workspacePath: string | null): void {
  useEffect(() => {
    if (!workspacePath || !isTauri()) return

    let unlisten: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    ;(async () => {
      const { listen } = await import('@tauri-apps/api/event')
      unlisten = await listen<{ path: string; kind: string }>('file-change', (event) => {
        if (!event.payload.path.endsWith('opencode.json')) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          console.log('[MCP] opencode.json changed, syncing MCP config')
          useMCPStore.getState().syncFromFile()
        }, 300)
      })
    })()

    return () => {
      if (timer) clearTimeout(timer)
      unlisten?.()
    }
  }, [workspacePath])
}
