import { useTranslation } from "react-i18next"
import { FileQuestion } from "lucide-react"

interface NativeContentProps {
  target: string
}

const nativeComponents: Record<string, React.ComponentType> = {}

export function NativeContent({ target }: NativeContentProps) {
  const { t } = useTranslation()
  const Component = nativeComponents[target]

  if (Component) {
    return <Component />
  }

  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center text-muted-foreground">
        <FileQuestion className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p className="text-sm">
          {t("nativeContent.notFound", "组件未找到")}
        </p>
        <p className="text-xs mt-1 opacity-70">{target}</p>
      </div>
    </div>
  )
}