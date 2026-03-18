import { useEffect, useState } from "react";
import { isTauri } from "@/lib/utils";

/** Detect macOS fullscreen state in Tauri — returns false in web mode or fullscreen */
export function useNeedsTrafficLightSpacer() {
  const [needsSpacer, setNeedsSpacer] = useState(() => isTauri())

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined

    ;(async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window")
        const win = getCurrentWindow()
        // Check initial state
        const fs = await win.isFullscreen()
        setNeedsSpacer(!fs)
        // Listen for changes
        unlisten = await win.onResized(async () => {
          const fs = await win.isFullscreen()
          setNeedsSpacer(!fs)
        })
      } catch {
        // fallback: assume needs spacer in Tauri
      }
    })()

    return () => { unlisten?.() }
  }, [])

  return needsSpacer
}
