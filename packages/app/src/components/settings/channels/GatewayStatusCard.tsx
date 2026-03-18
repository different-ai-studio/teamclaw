/**
 * GatewayStatusCard - Common gateway status display with expand/collapse,
 * start/stop/restart buttons, and toggle switch.
 * Used by all channel settings.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  Play,
  Square,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  BookOpen,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingCard, ToggleSwitch, StatusBadge } from './shared'

export interface GatewayStatusCardProps {
  /** The channel icon component */
  icon: React.ReactNode
  /** The gateway display name (e.g., "Discord Gateway") */
  title: string
  /** Gateway status */
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  /** Optional status detail line (e.g., "Connected as @bot") */
  statusDetail?: React.ReactNode
  /** Optional error message */
  errorMessage?: string
  /** Whether the panel is expanded */
  expanded: boolean
  /** Toggle expanded state */
  onToggleExpanded: () => void
  /** Whether the channel is enabled */
  enabled: boolean
  /** Toggle enabled state */
  onToggleEnabled: (enabled: boolean) => void
  /** Whether the store is loading */
  isLoading: boolean
  /** Whether gateway is connecting */
  isConnecting: boolean
  /** Whether gateway is running (connected or connecting) */
  isRunning: boolean
  /** Whether there are unsaved changes that need a restart */
  hasChanges: boolean
  /** Handle start/stop */
  onStartStop: () => void
  /** Handle restart (stop + save + start) */
  onRestart: () => void
  /** Whether start should be disabled (e.g., missing credentials) */
  startDisabled?: boolean
  /** Optional: show setup wizard button */
  onOpenWizard?: () => void
  /** Collapsible content */
  children?: React.ReactNode
}

export function GatewayStatusCard({
  icon,
  title,
  status,
  statusDetail,
  errorMessage,
  expanded,
  onToggleExpanded,
  enabled,
  onToggleEnabled,
  isLoading,
  isConnecting,
  isRunning,
  hasChanges,
  onStartStop,
  onRestart,
  startDisabled,
  onOpenWizard,
  children,
}: GatewayStatusCardProps) {
  const { t } = useTranslation()

  return (
    <SettingCard>
      {/* Header Row - always visible */}
      <div className="flex items-center justify-between">
        <button
          onClick={onToggleExpanded}
          className="flex items-center gap-4 flex-1 text-left"
        >
          {icon}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium">{title}</span>
              <StatusBadge status={status} />
            </div>
            {statusDetail}
            {errorMessage && (
              <p className="text-xs text-red-500">{errorMessage}</p>
            )}
          </div>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          )}
        </button>
        <div className="flex items-center gap-2 ml-3">
          {onOpenWizard && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenWizard}
              className="h-8 w-8 p-0"
              title={t('settings.channels.startSetup', 'Start Setup')}
            >
              <BookOpen className="h-4 w-4 text-muted-foreground" />
            </Button>
          )}
          <ToggleSwitch
            enabled={enabled}
            onChange={onToggleEnabled}
            disabled={isLoading}
          />
          {isRunning && hasChanges ? (
            <Button
              variant="default"
              size="sm"
              onClick={onRestart}
              disabled={isLoading || isConnecting}
              className="gap-2"
            >
              {isLoading || isConnecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <RefreshCw className="h-4 w-4" />
                  {t('settings.channels.restart', 'Restart')}
                </>
              )}
            </Button>
          ) : (
            <Button
              variant={isRunning ? 'destructive' : 'default'}
              size="sm"
              onClick={onStartStop}
              disabled={isLoading || isConnecting || (!isRunning && (startDisabled || !enabled))}
              className="gap-2"
            >
              {isLoading || isConnecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isRunning ? (
                <>
                  <Square className="h-4 w-4" />
                  {t('settings.channels.stop', 'Stop')}
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" />
                  {t('settings.channels.start', 'Start')}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Collapsible Content */}
      {expanded && children && (
        <div className="mt-5 pt-5 border-t space-y-5">
          {children}
        </div>
      )}
    </SettingCard>
  )
}
