import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { FileVersion } from '@/stores/version-history'

function formatRelativeTime(isoString: string, t: TFunction, language: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSecs < 60) return t('common.justNow')
  if (diffMins < 60) return t('common.minutesAgo', { count: diffMins })
  if (diffHours < 24) return t('common.hoursAgo', { count: diffHours })
  if (diffDays < 30) return t('common.daysAgo', { count: diffDays })
  return date.toLocaleDateString(language)
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
  const { t, i18n } = useTranslation()

  return (
    <ScrollArea className="h-full">
      <div className="py-2">
        {currentUpdatedBy && (
          <>
            <div className="px-3 py-1 text-xs font-medium text-muted-foreground">
              {t('versionHistory.currentVersion', 'Current version')}
            </div>
            <div
              className={cn(
                'mx-1 cursor-pointer rounded-md px-3 py-2',
                selectedIndex === null
                  ? 'bg-accent font-medium'
                  : 'hover:bg-accent/50'
              )}
              onClick={() => onSelect(-1)}
            >
              <div className="text-sm font-medium">{t('versionHistory.currentFile', 'Current file')}</div>
              <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <span>{currentUpdatedBy}</span>
                {currentUpdatedAt && (
                  <>
                    <span>·</span>
                    <span>{formatRelativeTime(currentUpdatedAt, t, i18n.language)}</span>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        <div className="mt-2 px-3 py-1 text-xs font-medium text-muted-foreground">
          {t('versionHistory.historicalVersionsTitle', 'Historical versions')}
        </div>
        {versions.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {t('versionHistory.noHistoricalVersions', 'No historical versions')}
          </div>
        )}
        {versions.map((version, i) => {
          const isSelected = selectedIndex === version.index
          return (
            <div
              key={version.index}
              className={cn(
                'mx-1 cursor-pointer rounded-md px-3 py-2',
                isSelected ? 'bg-accent font-medium' : 'hover:bg-accent/50'
              )}
              onClick={() => onSelect(version.index)}
            >
              <div className="text-sm">
                {t('versionHistory.versionLabel', { number: versions.length - i })}
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <span>{version.updatedBy}</span>
                <span>·</span>
                <span>{formatRelativeTime(version.updatedAt, t, i18n.language)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
