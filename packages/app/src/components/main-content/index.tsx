import { useTranslation } from "react-i18next"
import { Bookmark } from "lucide-react"
import { NativeContent } from "./NativeContent"
import { WebViewContent } from "./WebViewContent"

interface MainContentProps {
  type: "empty" | "native" | "webview"
  target: string | null
}

export function MainContent({ type, target }: MainContentProps) {
  const { t } = useTranslation()

  if (type === "empty" || !target) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-muted-foreground">
          <Bookmark className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">
            {t("mainContent.selectShortcut", "Select a shortcut to get started")}
          </p>
        </div>
      </div>
    )
  }

  if (type === "webview") {
    return (
      <div className="h-full">
        <WebViewContent url={target} />
      </div>
    )
  }

  return (
    <div className="h-full">
      <NativeContent target={target} />
    </div>
  )
}

export { NativeContent } from "./NativeContent"
export { WebViewContent } from "./WebViewContent"