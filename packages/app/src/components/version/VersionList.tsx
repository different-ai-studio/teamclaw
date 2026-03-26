import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { FileVersion } from '@/stores/version-history'

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSecs < 60) return '刚刚'
  if (diffMins < 60) return `${diffMins} 分钟前`
  if (diffHours < 24) return `${diffHours} 小时前`
  if (diffDays < 30) return `${diffDays} 天前`
  return date.toLocaleDateString('zh-CN')
}

interface VersionListProps {
  versions: FileVersion[]
  selectedIndex: number | null
  onSelect: (index: number) => void
  currentUpdatedBy?: string
  currentUpdatedAt?: string
}

export function VersionList({
  versions,
  selectedIndex,
  onSelect,
  currentUpdatedBy,
  currentUpdatedAt,
}: VersionListProps) {
  return (
    <ScrollArea className="h-full">
      <div className="py-2">
        {currentUpdatedBy && (
          <>
            <div className="px-3 py-1 text-xs font-medium text-muted-foreground">当前版本</div>
            <div
              className={cn(
                'mx-1 cursor-pointer rounded-md px-3 py-2',
                selectedIndex === null
                  ? 'bg-accent font-medium'
                  : 'hover:bg-accent/50'
              )}
              onClick={() => onSelect(-1)}
            >
              <div className="text-sm font-medium">当前文件</div>
              <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <span>{currentUpdatedBy}</span>
                {currentUpdatedAt && (
                  <>
                    <span>·</span>
                    <span>{formatRelativeTime(currentUpdatedAt)}</span>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        <div className="mt-2 px-3 py-1 text-xs font-medium text-muted-foreground">历史版本</div>
        {versions.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">暂无历史版本</div>
        )}
        {versions.map((version, i) => {
          const isSelected = selectedIndex === version.versionIndex
          return (
            <div
              key={version.versionIndex}
              className={cn(
                'mx-1 cursor-pointer rounded-md px-3 py-2',
                isSelected ? 'bg-accent font-medium' : 'hover:bg-accent/50'
              )}
              onClick={() => onSelect(version.versionIndex)}
            >
              <div className="text-sm">版本 {versions.length - i}</div>
              <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <span>{version.updatedBy}</span>
                <span>·</span>
                <span>{formatRelativeTime(version.updatedAt)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
