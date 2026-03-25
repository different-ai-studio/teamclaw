import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Copy,
  Check,
  RefreshCw,
  Loader2,
  Terminal,
  Package,
  Download,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn, isTauri, copyToClipboard } from '@/lib/utils'
import { buildConfig } from '@/lib/build-config'
import { useDepsStore } from '@/stores/deps'
import type { DependencyInfo } from '@/stores/deps'


function getPlatformCommand(commands: DependencyInfo['install_commands']): string {
  const platform = navigator.platform.toLowerCase()
  if (platform.includes('mac') || platform.includes('darwin')) {
    return commands.macos
  }
  if (platform.includes('win')) {
    return commands.windows
  }
  return commands.linux
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)

  const handleCopy = async () => {
    await copyToClipboard(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
      title={copied ? t('settings.deps.copied', 'Copied!') : t('settings.deps.copy', 'Copy')}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

// Reusable Card Component (same pattern as Settings.tsx)
function SettingCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn(
      "rounded-xl border bg-card p-5 transition-all",
      className
    )}>
      {children}
    </div>
  )
}

// Reusable Section Header
function SectionHeader({ 
  icon: Icon, 
  title, 
  description, 
  iconColor 
}: { 
  icon: React.ElementType
  title: string
  description: string
  iconColor?: string 
}) {
  return (
    <div className="flex items-start gap-3 mb-6">
      <div className={cn("p-2 rounded-lg bg-primary/5", iconColor)}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <h3 className="font-semibold text-lg">{title}</h3>
        <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
      </div>
    </div>
  )
}

function InstallButton({ dep }: { dep: DependencyInfo }) {
  const { t } = useTranslation()
  const { installDependencies, installing, currentInstalling, installResults, checkDependencies, resetInstallState } = useDepsStore()
  const isInstallingThis = currentInstalling === dep.name
  const result = installResults[dep.name]
  const isDone = result?.success
  const isFailed = result?.error !== undefined && !result?.success

  const handleInstall = async () => {
    resetInstallState()
    await installDependencies([dep.name])
    await checkDependencies()
  }

  if (isDone) {
    return (
      <span className="text-xs text-green-500 flex items-center gap-1">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {t('settings.deps.installed', 'Installed')}
      </span>
    )
  }

  if (isFailed) {
    return (
      <Button variant="outline" size="sm" onClick={handleInstall} className="gap-1.5 text-red-500 hover:text-red-600">
        <RefreshCw className="h-3 w-3" />
        {t('settings.deps.retry', 'Retry')}
      </Button>
    )
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleInstall}
      disabled={installing}
      className="gap-1.5"
    >
      {isInstallingThis ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Download className="h-3 w-3" />
      )}
      {isInstallingThis ? t('settings.deps.installing', 'Installing...') : t('settings.deps.install', 'Install')}
    </Button>
  )
}

export function DependenciesSection() {
  const { t } = useTranslation()
  const { dependencies: deps, loading: isLoading, checkDependencies } = useDepsStore()
  const [isChecking, setIsChecking] = React.useState(false)

  // Trigger initial check if not yet done
  React.useEffect(() => {
    if (deps.length === 0 && !isLoading) {
      checkDependencies()
    }
  }, [deps.length, isLoading, checkDependencies])

  const handleRecheck = async () => {
    setIsChecking(true)
    await checkDependencies()
    setIsChecking(false)
  }

  const installedCount = deps.filter((d) => d.installed).length
  const totalCount = deps.length

  if (!isTauri()) {
    return (
      <div className="space-y-6">
        <SectionHeader
          icon={Package}
          title={t('settings.deps.title', 'Dependencies')}
          description={t('settings.deps.description', { defaultValue: 'External tools required by {{appName}}', appName: buildConfig.app.name })}
          iconColor="text-teal-500"
        />
        <SettingCard>
          <p className="text-sm text-muted-foreground">
            {t('settings.deps.desktopOnly', 'Dependency checking is only available in the desktop app.')}
          </p>
        </SettingCard>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Package}
        title={t('settings.deps.title', 'Dependencies')}
        description={t('settings.deps.description', { defaultValue: 'External tools required by {{appName}}', appName: buildConfig.app.name })}
        iconColor="text-teal-500"
      />

      {isLoading ? (
        <SettingCard>
          <div className="flex items-center justify-center py-8 gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{t('settings.deps.checking', 'Checking dependencies...')}</span>
          </div>
        </SettingCard>
      ) : (
        <>
          {/* Summary */}
          <SettingCard>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {installedCount === totalCount ? (
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                )}
                <span className="text-sm font-medium">
                  {installedCount === totalCount
                    ? t('settings.deps.allInstalled', 'All dependencies installed')
                    : t('settings.deps.installedCount', { installed: installedCount, total: totalCount, defaultValue: `${installedCount}/${totalCount} installed` })}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRecheck}
                disabled={isChecking}
                className="gap-1.5"
              >
                {isChecking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {t('settings.deps.recheck', 'Re-check')}
              </Button>
            </div>
          </SettingCard>

          {/* Dependency list */}
          <SettingCard>
            <div className="space-y-4">
              {deps.map((dep) => {
                const command = getPlatformCommand(dep.install_commands)
                return (
                  <div
                    key={dep.name}
                    className={cn(
                      'flex items-start gap-3 p-3 rounded-lg border',
                      dep.installed ? 'bg-card' : 'bg-amber-50/50 dark:bg-amber-950/10'
                    )}
                  >
                    {/* Status */}
                    <div className="mt-0.5">
                      {dep.installed ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : dep.required ? (
                        <XCircle className="h-4 w-4 text-red-500" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{dep.name}</span>
                        {dep.installed && dep.version && (
                          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono">
                            {dep.version}
                          </span>
                        )}
                        {dep.required ? (
                          <span className="text-[10px] uppercase tracking-wider font-medium text-red-600 dark:text-red-400">
                            {t('settings.deps.required', 'Required')}
                          </span>
                        ) : (
                          <span className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground">
                            {t('settings.deps.optional', 'Optional')}
                          </span>
                        )}
                        {/* Install button for missing deps */}
                        {!dep.installed && (
                          <div className="ml-auto">
                            <InstallButton dep={dep} />
                          </div>
                        )}
                      </div>

                      <p className="text-xs text-muted-foreground">{dep.description}</p>

                      {/* Install command */}
                      {!dep.installed && (
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <div className="flex items-center gap-1.5 bg-muted/50 border rounded px-2 py-1 font-mono text-xs flex-1 min-w-0">
                            <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span className="truncate">{command}</span>
                          </div>
                          <CopyButton text={command} />
                        </div>
                      )}

                      {/* Affected features */}
                      {!dep.installed && dep.affected_features.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {dep.affected_features.map((f) => (
                            <span key={f} className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                              {f}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </SettingCard>
        </>
      )}
    </div>
  )
}
