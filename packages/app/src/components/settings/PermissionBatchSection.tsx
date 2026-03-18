import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Shield,
  Bell,
  FolderOpen,
  Terminal,
  CheckCircle2,
  RefreshCw,
  Accessibility,
  MonitorPlay,
  Mouse,
  ExternalLink,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingCard, SectionHeader } from './shared'
import { isBatchDone, setBatchDone } from '@/lib/permission-policy'
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification'
import { open } from '@tauri-apps/plugin-shell'

interface PermissionItem {
  id: string
  icon: React.ElementType
  nameKey: string
  nameFallback: string
  descKey: string
  descFallback: string
  /** Whether this requires manual OS-level granting (cannot be programmatic) */
  manual?: boolean
}

const PERMISSION_ITEMS: PermissionItem[] = [
  {
    id: 'notification',
    icon: Bell,
    nameKey: 'permission.batchNotifPermission',
    nameFallback: 'Desktop Notifications',
    descKey: 'permission.batchNotifDesc',
    descFallback: 'Allow sending desktop notifications',
  },
  {
    id: 'accessibility',
    icon: Accessibility,
    nameKey: 'permission.batchAccessibilityPermission',
    nameFallback: 'Accessibility',
    descKey: 'permission.batchAccessibilityDesc',
    descFallback: 'Required for mouse/keyboard automation (autoui MCP, macOS control)',
    manual: true,
  },
  {
    id: 'screen-recording',
    icon: MonitorPlay,
    nameKey: 'permission.batchScreenRecordingPermission',
    nameFallback: 'Screen Recording',
    descKey: 'permission.batchScreenRecordingDesc',
    descFallback: 'Required for screen capture and vision-based UI automation',
    manual: true,
  },
  {
    id: 'file',
    icon: FolderOpen,
    nameKey: 'permission.batchFilePermission',
    nameFallback: 'File Read/Write',
    descKey: 'permission.batchFileDesc',
    descFallback: 'Allow reading and writing files in the workspace',
  },
  {
    id: 'shell',
    icon: Terminal,
    nameKey: 'permission.batchShellPermission',
    nameFallback: 'Shell Execute',
    descKey: 'permission.batchShellDesc',
    descFallback: 'Allow executing shell commands',
  },
  {
    id: 'input-monitoring',
    icon: Mouse,
    nameKey: 'permission.batchInputMonitoringPermission',
    nameFallback: 'Input Monitoring',
    descKey: 'permission.batchInputMonitoringDesc',
    descFallback: 'Required for keyboard input simulation (autoui MCP)',
    manual: true,
  },
]

export const PermissionBatchSection = React.memo(function PermissionBatchSection() {
  const { t } = useTranslation()
  const [batchDone, setBatchDoneState] = React.useState(isBatchDone)
  const [isGranting, setIsGranting] = React.useState(false)
  const [result, setResult] = React.useState<'success' | 'partial' | null>(null)

  const handleOpenSystemSettings = React.useCallback(async () => {
    try {
      // Open macOS Privacy & Security settings
      await open('x-apple.systempreferences:com.apple.preference.security?Privacy')
    } catch {
      // Fallback: try opening System Settings directly
      try {
        await open('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension')
      } catch {
        // Ignore if cannot open
      }
    }
  }, [])

  const handleGrantAll = React.useCallback(async () => {
    setIsGranting(true)
    setResult(null)

    let notifGranted = false

    try {
      // Request notification permission
      const alreadyGranted = await isPermissionGranted()
      if (alreadyGranted) {
        notifGranted = true
      } else {
        const permission = await requestPermission()
        notifGranted = permission === 'granted'
      }
    } catch {
      // Notification API not available
    }

    // File and Shell permissions are managed by OpenCode's permission system.
    // After batch is marked done, all OpenCode permission requests will be
    // auto-authorized with "always" by the session store.

    // Mark batch as done
    setBatchDone(true)
    setBatchDoneState(true)

    // Show result
    setResult(notifGranted ? 'success' : 'partial')

    setIsGranting(false)
  }, [])

  const handleReauthorize = React.useCallback(async () => {
    // Reset batch state and re-run
    setBatchDone(false)
    setBatchDoneState(false)
    setResult(null)
    // Will be re-triggered by user clicking Grant All again
  }, [])

  return (
    <SettingCard>
      <SectionHeader
        icon={Shield}
        title={t('permission.batchTitle', 'Permission Management')}
        description={t('permission.batchDesc', 'Grant all basic permissions at once')}
        iconColor="text-emerald-500"
      />

      <div className="mt-4 space-y-3">
        {PERMISSION_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <div
              key={item.id}
              className="flex items-center gap-3 p-3 rounded-lg bg-muted/50"
            >
              <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{t(item.nameKey, item.nameFallback)}</p>
                  {item.manual && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium">
                      {t('permission.manualLabel', 'Manual')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{t(item.descKey, item.descFallback)}</p>
              </div>
              {batchDone && !item.manual && (
                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
              )}
            </div>
          )
        })}

        <button
          type="button"
          onClick={handleOpenSystemSettings}
          className="flex items-center gap-2 text-xs text-primary hover:underline mt-2 px-3"
        >
          <ExternalLink className="h-3 w-3" />
          {t('permission.openSystemSettings', 'Open System Settings → Privacy & Security')}
        </button>
      </div>

      <div className="mt-4 flex items-center gap-3">
        {batchDone ? (
          <>
            <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              {t('permission.batchCompleted', 'Completed')}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleReauthorize}
              className="ml-auto"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              {t('permission.reauthorize', 'Re-authorize')}
            </Button>
          </>
        ) : (
          <Button
            onClick={handleGrantAll}
            disabled={isGranting}
            className="w-full"
          >
            <Shield className="h-4 w-4 mr-2" />
            {isGranting ? '...' : t('permission.grantAll', 'Grant All')}
          </Button>
        )}
      </div>

      {result && (
        <p className="mt-3 text-xs text-muted-foreground">
          {result === 'success'
            ? t('permission.batchSuccess', 'All permissions granted successfully')
            : t('permission.batchPartial', 'Permissions granted (some may require OS confirmation)')
          }
        </p>
      )}
    </SettingCard>
  )
})
