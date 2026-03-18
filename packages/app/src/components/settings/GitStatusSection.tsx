import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  RefreshCw,
  GitBranch,
  Eye,
  Palette,
  RotateCcw,
} from 'lucide-react'
import { GitStatus } from '@/lib/git/service'
import { useGitSettingsStore, DEFAULT_STATUS_COLORS } from '@/stores/git-settings'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { SettingCard, SectionHeader, ToggleSwitch } from './shared'
import { GitReposSection } from './GitReposSection'

export const GitStatusSection = React.memo(function GitStatusSection() {
  const showGitStatus = useGitSettingsStore((s) => s.showGitStatus)
  const showStatusIcons = useGitSettingsStore((s) => s.showStatusIcons)
  const statusColors = useGitSettingsStore((s) => s.statusColors)
  const pollingInterval = useGitSettingsStore((s) => s.pollingInterval)
  const setShowGitStatus = useGitSettingsStore((s) => s.setShowGitStatus)
  const setShowStatusIcons = useGitSettingsStore((s) => s.setShowStatusIcons)
  const setStatusColor = useGitSettingsStore((s) => s.setStatusColor)
  const resetStatusColors = useGitSettingsStore((s) => s.resetStatusColors)
  const setPollingInterval = useGitSettingsStore((s) => s.setPollingInterval)

  const { t } = useTranslation()
  const statusItems: { status: GitStatus; label: string; defaultColor: string }[] = [
    { status: GitStatus.MODIFIED, label: t('settings.gitStatus.modified', 'Modified'), defaultColor: DEFAULT_STATUS_COLORS[GitStatus.MODIFIED] },
    { status: GitStatus.ADDED, label: t('settings.gitStatus.added', 'Added'), defaultColor: DEFAULT_STATUS_COLORS[GitStatus.ADDED] },
    { status: GitStatus.DELETED, label: t('settings.gitStatus.deleted', 'Deleted'), defaultColor: DEFAULT_STATUS_COLORS[GitStatus.DELETED] },
    { status: GitStatus.UNTRACKED, label: t('settings.gitStatus.untracked', 'Untracked'), defaultColor: DEFAULT_STATUS_COLORS[GitStatus.UNTRACKED] },
    { status: GitStatus.STAGED, label: t('settings.gitStatus.staged', 'Staged'), defaultColor: DEFAULT_STATUS_COLORS[GitStatus.STAGED] },
    { status: GitStatus.RENAMED, label: t('settings.gitStatus.renamed', 'Renamed'), defaultColor: DEFAULT_STATUS_COLORS[GitStatus.RENAMED] },
  ]

  const colorOptions = [
    { value: 'text-yellow-500', label: t('settings.gitStatus.yellow', 'Yellow') },
    { value: 'text-green-500', label: t('settings.gitStatus.green', 'Green') },
    { value: 'text-red-500', label: t('settings.gitStatus.red', 'Red') },
    { value: 'text-blue-500', label: t('settings.gitStatus.blue', 'Blue') },
    { value: 'text-purple-500', label: t('settings.gitStatus.purple', 'Purple') },
    { value: 'text-cyan-500', label: t('settings.gitStatus.cyan', 'Cyan') },
    { value: 'text-orange-500', label: t('settings.gitStatus.orange', 'Orange') },
    { value: 'text-pink-500', label: t('settings.gitStatus.pink', 'Pink') },
    { value: 'text-gray-400', label: t('settings.gitStatus.gray', 'Gray') },
    { value: 'text-amber-500', label: t('settings.gitStatus.amber', 'Amber') },
    { value: 'text-emerald-500', label: t('settings.gitStatus.emerald', 'Emerald') },
    { value: 'text-indigo-500', label: t('settings.gitStatus.indigo', 'Indigo') },
  ]

  const pollingOptions = [
    { value: 15000, label: t('settings.gitStatus.15sec', '15 seconds') },
    { value: 30000, label: t('settings.gitStatus.30sec', '30 seconds') },
    { value: 60000, label: t('settings.gitStatus.1min', '1 minute') },
    { value: 120000, label: t('settings.gitStatus.2min', '2 minutes') },
    { value: 300000, label: t('settings.gitStatus.5min', '5 minutes') },
  ]

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={GitBranch}
        title={t('settings.gitStatus.title', 'Git Status')}
        description={t('settings.gitStatus.description', 'Configure how Git file status is displayed in the file tree')}
        iconColor="text-orange-500"
      />

      {/* Toggle Git Status Display */}
      <SettingCard>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <label className="text-sm font-medium flex items-center gap-2">
                <Eye className="h-4 w-4 text-muted-foreground" />
                {t('settings.gitStatus.showStatus', 'Show Git Status')}
              </label>
              <p className="text-xs text-muted-foreground">
                {t('settings.gitStatus.showStatusDesc', 'Display file change indicators in the file tree')}
              </p>
            </div>
            <ToggleSwitch enabled={showGitStatus} onChange={setShowGitStatus} />
          </div>

          <div className="border-t pt-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <label className="text-sm font-medium flex items-center gap-2">
                  <Palette className="h-4 w-4 text-muted-foreground" />
                  {t('settings.gitStatus.statusIcons', 'Status Icons')}
                </label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.gitStatus.statusIconsDesc', 'Show distinct icons per status type (color-blind friendly)')}
                </p>
              </div>
              <ToggleSwitch enabled={showStatusIcons} onChange={setShowStatusIcons} />
            </div>
          </div>
        </div>
      </SettingCard>

      {/* Color Configuration */}
      <SettingCard>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-medium flex items-center gap-2">
              <Palette className="h-4 w-4 text-muted-foreground" />
              {t('settings.gitStatus.statusColors', 'Status Colors')}
            </h4>
            <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={resetStatusColors}>
              <RotateCcw className="h-3 w-3" />
              {t('settings.gitStatus.reset', 'Reset')}
            </Button>
          </div>

          <div className="space-y-3">
            {statusItems.map(({ status, label }) => (
              <div key={status} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={cn('w-3 h-3 rounded-full', statusColors[status]?.replace('text-', 'bg-'))} />
                  <span className="text-sm">{label}</span>
                </div>
                <Select
                  value={statusColors[status]}
                  onValueChange={(value) => setStatusColor(status, value)}
                >
                  <SelectTrigger className="w-[140px] h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {colorOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        <span className="flex items-center gap-2">
                          <span className={cn('w-2 h-2 rounded-full', opt.value.replace('text-', 'bg-'))} />
                          {opt.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </div>
      </SettingCard>

      {/* Polling Interval */}
      <SettingCard>
        <div className="space-y-2">
          <label className="text-sm font-medium flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
            {t('settings.gitStatus.refreshInterval', 'Refresh Interval')}
          </label>
          <Select
            value={String(pollingInterval)}
            onValueChange={(value) => setPollingInterval(Number(value))}
          >
            <SelectTrigger className="h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pollingOptions.map((opt) => (
                <SelectItem key={opt.value} value={String(opt.value)}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t('settings.gitStatus.refreshIntervalDesc', 'How often to automatically check for Git status changes')}
          </p>
        </div>
      </SettingCard>

      {/* Git Repositories */}
      <GitReposSection />
    </div>
  )
})
