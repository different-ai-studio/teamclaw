import { useCallback, useEffect, useState } from "react"
import { ArrowLeft, ArrowRight, RotateCw, Lock } from "lucide-react"
import { cn, isTauri } from "@/lib/utils"
import { normalizeUrl } from "@/lib/webview-utils"

interface WebViewToolbarProps {
  /** The original URL from the tab target */
  url: string
  /** Stable webview label for invoking Rust commands */
  label: string
}

export function WebViewToolbar({ url: rawUrl, label }: WebViewToolbarProps) {
  const url = normalizeUrl(rawUrl)
  const [currentUrl, setCurrentUrl] = useState(url)

  // Poll the current URL periodically to keep address bar in sync
  useEffect(() => {
    if (!isTauri()) {
      setCurrentUrl(url)
      return
    }

    let cancelled = false
    const poll = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        const result = await invoke<string>("webview_get_url", { label })
        if (!cancelled && result) setCurrentUrl(result)
      } catch {
        // ignore
      }
    }

    // Initial fetch after a short delay (webview might still be loading)
    const initialTimer = setTimeout(poll, 2000)
    // Poll every 2s to catch navigation changes
    const interval = setInterval(poll, 2000)

    return () => {
      cancelled = true
      clearTimeout(initialTimer)
      clearInterval(interval)
    }
  }, [label, url])

  const invokeWebview = useCallback(async (command: string) => {
    if (!isTauri()) return
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke(command, { label }).catch(() => {})
  }, [label])

  const goBack = useCallback(() => invokeWebview("webview_go_back"), [invokeWebview])
  const goForward = useCallback(() => invokeWebview("webview_go_forward"), [invokeWebview])
  const reload = useCallback(() => invokeWebview("webview_reload"), [invokeWebview])

  const isHttps = currentUrl.startsWith("https://")
  // Strip protocol for display
  const displayUrl = currentUrl.replace(/^https?:\/\//, "")

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b bg-muted/30 shrink-0 pointer-events-auto">
      {/* Navigation buttons */}
      <NavButton onClick={goBack} title="Back">
        <ArrowLeft className="h-3.5 w-3.5" />
      </NavButton>
      <NavButton onClick={goForward} title="Forward">
        <ArrowRight className="h-3.5 w-3.5" />
      </NavButton>
      <NavButton onClick={reload} title="Reload">
        <RotateCw className="h-3.5 w-3.5" />
      </NavButton>

      {/* Address bar (read-only) */}
      <div className="flex-1 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-background/80 border text-xs text-muted-foreground min-w-0 ml-1">
        {isHttps && <Lock className="h-3 w-3 shrink-0 text-green-600" />}
        <span className="truncate select-text">{displayUrl}</span>
      </div>
    </div>
  )
}

function NavButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "p-1.5 rounded-md text-muted-foreground",
        "hover:bg-muted hover:text-foreground",
        "transition-colors duration-150",
      )}
    >
      {children}
    </button>
  )
}
