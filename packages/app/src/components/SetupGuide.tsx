import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { copyToClipboard } from '@/lib/utils'
import {
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  RefreshCw,
  Loader2,
  ArrowRight,
  AlertTriangle,
  Terminal,
  Package,
  Info,
  RotateCcw,
  Settings2,
  Download,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDepsStore, type DependencyInfo } from '@/stores/deps'
import { buildConfig } from '@/lib/build-config'

export type { DependencyInfo }

type Phase = 'overview' | 'customize' | 'installing' | 'results'

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

function isMacOS(): boolean {
  return navigator.platform.toLowerCase().includes('mac') || navigator.platform.toLowerCase().includes('darwin')
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await copyToClipboard(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
      title={copied ? t('common.copied', 'Copied!') : t('setup.copyCommand', 'Copy command')}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

function DependencyRow({ dep }: { dep: DependencyInfo }) {
  const { t } = useTranslation()
  const command = getPlatformCommand(dep.install_commands)

  return (
    <div className="flex items-start gap-4 p-4 rounded-lg border bg-card">
      <div className="mt-0.5">
        {dep.installed ? (
          <CheckCircle2 className="h-5 w-5 text-green-500" />
        ) : dep.required ? (
          <XCircle className="h-5 w-5 text-red-500" />
        ) : (
          <AlertTriangle className="h-5 w-5 text-amber-500" />
        )}
      </div>

      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{dep.name}</span>
          {dep.installed && dep.version && (
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              v{dep.version}
            </span>
          )}
          {dep.required ? (
            <span className="text-[10px] uppercase tracking-wider font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 px-1.5 py-0.5 rounded">
              {t('setup.required', 'Required')}
            </span>
          ) : (
            <span className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {t('setup.optional', 'Optional')}
            </span>
          )}
        </div>

        <p className="text-xs text-muted-foreground">{dep.description}</p>

        {!dep.installed && (
          <div className="flex items-center gap-2 mt-2">
            <div className="flex items-center gap-1.5 bg-muted/50 border rounded-md px-3 py-1.5 font-mono text-xs flex-1 min-w-0">
              <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="truncate">{command}</span>
            </div>
            <CopyButton text={command} />
          </div>
        )}

        {!dep.installed && dep.affected_features.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {dep.affected_features.map((feature) => (
              <span
                key={feature}
                className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded"
              >
                {feature}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Overview Phase ───────────────────────────────────────────────────────────

function OverviewPhase({
  deps,
  onInstallAllRequired,
  onCustomize,
  onSkip,
  onRecheck,
}: {
  deps: DependencyInfo[]
  onInstallAllRequired: () => void
  onCustomize: () => void
  onSkip: () => void
  onRecheck: () => void
}) {
  const { t } = useTranslation()
  const [isChecking, setIsChecking] = useState(false)

  const allRequiredInstalled = deps.filter((d) => d.required).every((d) => d.installed)
  const missingRequired = deps.filter((d) => d.required && !d.installed)
  const missingOptional = deps.filter((d) => !d.required && !d.installed)
  const allInstalled = deps.every((d) => d.installed)

  const handleRecheck = async () => {
    setIsChecking(true)
    try {
      await useDepsStore.getState().checkDependencies()
    } finally {
      setIsChecking(false)
    }
    onRecheck()
  }

  return (
    <>
      {/* Dependencies list */}
      <div className="space-y-3">
        {deps.map((dep) => (
          <DependencyRow key={dep.name} dep={dep} />
        ))}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-3 pt-2">
        <div className="flex items-center gap-3">
          {/* Install All Required */}
          {missingRequired.length > 0 && (
            <Button onClick={onInstallAllRequired} className="gap-2 flex-1">
              <Download className="h-4 w-4" />
              {t('setup.installAllRequired', 'Install All Required')}
            </Button>
          )}

          {/* Customize */}
          {(missingRequired.length > 0 || missingOptional.length > 0) && (
            <Button variant="outline" onClick={onCustomize} className="gap-2">
              <Settings2 className="h-4 w-4" />
              {t('setup.customize', 'Customize')}
            </Button>
          )}
        </div>

        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRecheck}
            disabled={isChecking}
            className="gap-2"
          >
            {isChecking ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t('setup.recheck', 'Re-check')}
          </Button>

          {allRequiredInstalled && (
            <Button onClick={onSkip} variant={allInstalled ? 'default' : 'outline'} className="gap-2">
              {allInstalled ? t('setup.getStarted', 'Get Started') : t('setup.skip', 'Skip')}
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {allRequiredInstalled && !allInstalled && (
        <p className="text-xs text-center text-muted-foreground">
          {t('setup.optionalHint', '{{count}} optional {{singular}} missing. You can install {{pronoun}} later from Settings.', {
            count: missingOptional.length,
            singular: missingOptional.length === 1 ? 'tool is' : 'tools are',
            pronoun: missingOptional.length === 1 ? 'it' : 'them',
          })}
        </p>
      )}
    </>
  )
}

// ─── Customize Phase ──────────────────────────────────────────────────────────

function CustomizePhase({
  deps,
  onInstall,
  onBack,
}: {
  deps: DependencyInfo[]
  onInstall: (names: string[]) => void
  onBack: () => void
}) {
  const { t } = useTranslation()
  const missingDeps = deps.filter((d) => !d.installed)
  const [selected, setSelected] = useState<Set<string>>(() => {
    // Required deps are always selected
    return new Set(missingDeps.filter((d) => d.required).map((d) => d.name))
  })

  const toggleDep = (name: string) => {
    // Don't allow unchecking required deps
    const dep = missingDeps.find((d) => d.name === name)
    if (dep?.required) return

    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  const handleInstall = () => {
    onInstall(Array.from(selected))
  }

  return (
    <>
      <div className="space-y-2">
        {missingDeps.map((dep) => {
          const isSelected = selected.has(dep.name)
          const isRequired = dep.required
          return (
            <label
              key={dep.name}
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                isSelected ? 'bg-primary/5 border-primary/30' : 'bg-card hover:bg-muted/50'
              } ${isRequired ? 'cursor-default' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                toggleDep(dep.name)
              }}
            >
              <input
                type="checkbox"
                checked={isSelected}
                disabled={isRequired}
                onChange={() => toggleDep(dep.name)}
                className="rounded border-muted-foreground/50 text-primary focus:ring-primary h-4 w-4"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{dep.name}</span>
                  {isRequired ? (
                    <span className="text-[10px] uppercase tracking-wider font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 px-1.5 py-0.5 rounded">
                      {t('setup.required', 'Required')}
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {t('setup.optional', 'Optional')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{dep.description}</p>
              </div>
            </label>
          )
        })}
      </div>

      <div className="flex items-center justify-between pt-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
          {t('setup.back', 'Back')}
        </Button>
        <Button onClick={handleInstall} disabled={selected.size === 0} className="gap-2">
          <Download className="h-4 w-4" />
          {t('setup.installSelected', 'Install Selected')} ({selected.size})
        </Button>
      </div>
    </>
  )
}

// ─── Installing Phase ─────────────────────────────────────────────────────────

function InstallingPhase() {
  const { t } = useTranslation()
  const {
    installQueue,
    currentInstalling,
    installResults,
    installOutput,
  } = useDepsStore()

  const logRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom of terminal output
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [installOutput, currentInstalling])

  const completedCount = Object.values(installResults).filter(
    (r) => r.success || r.error
  ).length
  const totalCount = installQueue.length

  // Get current output lines
  const currentOutput = currentInstalling ? (installOutput[currentInstalling] || []) : []

  // Check if brew is being installed on macOS
  const isInstallingBrew = currentInstalling === 'brew' && isMacOS()

  return (
    <>
      {/* Progress header */}
      <div className="flex items-center gap-3 p-4 rounded-lg border bg-card">
        <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-medium">
            {t('setup.installing', 'Installing')} {completedCount + 1}/{totalCount}...
          </p>
          {currentInstalling && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {currentInstalling}
            </p>
          )}
        </div>
      </div>

      {/* Password prompt notice for Homebrew */}
      {isInstallingBrew && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30">
          <Info className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
          <p className="text-xs text-blue-700 dark:text-blue-300">
            {t('setup.passwordPrompt', 'You may be prompted for your system password by macOS to complete the Homebrew installation.')}
          </p>
        </div>
      )}

      {/* Terminal output */}
      <div
        ref={logRef}
        className="h-48 overflow-y-auto rounded-lg border bg-zinc-950 p-3 font-mono text-xs text-zinc-300 space-y-0.5"
      >
        {currentOutput.length === 0 ? (
          <p className="text-zinc-500">{t('setup.waitingForOutput', 'Waiting for output...')}</p>
        ) : (
          currentOutput.map((line, i) => (
            <div key={i} className="leading-relaxed break-all">
              {line}
            </div>
          ))
        )}
      </div>

      {/* Progress dots for completed deps */}
      <div className="flex items-center gap-2 justify-center">
        {installQueue.map((name) => {
          const result = installResults[name]
          const isCurrent = name === currentInstalling
          const isDone = result?.success
          const isFailed = result?.error !== undefined && !result?.success
          return (
            <div
              key={name}
              className={`h-2 w-2 rounded-full transition-colors ${
                isDone
                  ? 'bg-green-500'
                  : isFailed
                    ? 'bg-red-500'
                    : isCurrent
                      ? 'bg-primary animate-pulse'
                      : 'bg-muted'
              }`}
              title={name}
            />
          )
        })}
      </div>
    </>
  )
}

// ─── Results Phase ────────────────────────────────────────────────────────────

function ResultsPhase({
  deps,
  onRetry,
  onContinue,
}: {
  deps: DependencyInfo[]
  onRetry: (names: string[]) => void
  onContinue: () => void
}) {
  const { t } = useTranslation()
  const { installQueue, installResults } = useDepsStore()

  const succeeded = installQueue.filter((n) => installResults[n]?.success)
  const failed = installQueue.filter((n) => !installResults[n]?.success)

  const allRequiredInstalled = deps.filter((d) => d.required).every((d) => d.installed)

  return (
    <>
      {/* Success summary */}
      {succeeded.length > 0 && (
        <div className="p-4 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <span className="text-sm font-medium text-green-700 dark:text-green-300">
              {t('setup.installSuccess', '{{count}} installed successfully', { count: succeeded.length })}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {succeeded.map((name) => (
              <span key={name} className="text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-2 py-0.5 rounded">
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Failure summary */}
      {failed.length > 0 && (
        <div className="p-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 space-y-3">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-500" />
            <span className="text-sm font-medium text-red-700 dark:text-red-300">
              {t('setup.installFailed', '{{count}} failed to install', { count: failed.length })}
            </span>
          </div>
          {failed.map((name) => {
            const dep = deps.find((d) => d.name === name)
            const command = dep ? getPlatformCommand(dep.install_commands) : ''
            const error = installResults[name]?.error
            return (
              <div key={name} className="space-y-1">
                <p className="text-xs font-medium text-red-600 dark:text-red-400">{name}</p>
                {error && (
                  <p className="text-xs text-red-500/80">{error}</p>
                )}
                {command && (
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 bg-red-100/50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md px-3 py-1.5 font-mono text-xs flex-1 min-w-0">
                      <Terminal className="h-3 w-3 text-red-400 shrink-0" />
                      <span className="truncate text-red-600 dark:text-red-300">{command}</span>
                    </div>
                    <CopyButton text={command} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-2">
        {failed.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => onRetry(failed)} className="gap-2">
            <RotateCcw className="h-4 w-4" />
            {t('setup.retryFailed', 'Retry Failed')}
          </Button>
        )}
        <div className="ml-auto">
          {allRequiredInstalled && (
            <Button onClick={onContinue} className="gap-2">
              {t('setup.continue', 'Continue')}
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Main SetupGuide ──────────────────────────────────────────────────────────

interface SetupGuideProps {
  dependencies: DependencyInfo[]
  onRecheck: () => Promise<DependencyInfo[]>
  onContinue: () => void
}

export function SetupGuide({ onContinue }: SetupGuideProps) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('overview')
  const {
    dependencies: deps,
    installing,
    installDependencies,
    checkDependencies,
    resetInstallState,
  } = useDepsStore()

  // Auto-transition from installing → results when done
  useEffect(() => {
    if (phase === 'installing' && !installing) {
      // Installation finished — auto-recheck and go to results
      checkDependencies().then((updatedDeps) => {
        setPhase('results')

        // Auto-advance if all required deps are now installed
        const allRequiredOk = updatedDeps.filter((d) => d.required).every((d) => d.installed)
        if (allRequiredOk) {
          const timer = setTimeout(() => {
            onContinue()
          }, 2000)
          return () => clearTimeout(timer)
        }
      })
    }
  }, [phase, installing, checkDependencies, onContinue])

  const handleInstallAllRequired = useCallback(() => {
    const missingRequired = deps.filter((d) => d.required && !d.installed).map((d) => d.name)
    if (missingRequired.length === 0) return
    resetInstallState()
    setPhase('installing')
    installDependencies(missingRequired)
  }, [deps, installDependencies, resetInstallState])

  const handleInstallSelected = useCallback((names: string[]) => {
    if (names.length === 0) return
    resetInstallState()
    setPhase('installing')
    installDependencies(names)
  }, [installDependencies, resetInstallState])

  const handleRetry = useCallback((names: string[]) => {
    resetInstallState()
    setPhase('installing')
    installDependencies(names)
  }, [installDependencies, resetInstallState])

  const handleOverviewRecheck = useCallback(() => {
    // deps are already updated in the store by the handler
    // If all required installed, auto-skip
    const allRequiredOk = useDepsStore.getState().dependencies.filter((d) => d.required).every((d) => d.installed)
    if (allRequiredOk && useDepsStore.getState().dependencies.every((d) => d.installed)) {
      onContinue()
    }
  }, [onContinue])

  const phaseTitle = {
    overview: t('setup.title', 'Setup Required'),
    customize: t('setup.customizeTitle', 'Select Dependencies'),
    installing: t('setup.installingTitle', 'Installing Dependencies'),
    results: t('setup.resultsTitle', 'Installation Complete'),
  }

  const phaseDescription = {
    overview: t('setup.intro', { defaultValue: '{{appName}} needs a few tools to work properly. Install the missing dependencies to get started.', appName: buildConfig.app.name }),
    customize: t('setup.customizeIntro', 'Choose which dependencies to install. Required tools are pre-selected.'),
    installing: t('setup.installingIntro', 'Please wait while dependencies are being installed...'),
    results: t('setup.resultsIntro', 'Installation has finished. See the results below.'),
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-background p-8">
      <div className="max-w-lg w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-2">
            <Package className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold">{phaseTitle[phase]}</h1>
          <p className="text-sm text-muted-foreground">
            {phaseDescription[phase]}
          </p>
        </div>

        {/* Phase content */}
        {phase === 'overview' && (
          <OverviewPhase
            deps={deps}
            onInstallAllRequired={handleInstallAllRequired}
            onCustomize={() => setPhase('customize')}
            onSkip={onContinue}
            onRecheck={handleOverviewRecheck}
          />
        )}
        {phase === 'customize' && (
          <CustomizePhase
            deps={deps}
            onInstall={handleInstallSelected}
            onBack={() => setPhase('overview')}
          />
        )}
        {phase === 'installing' && (
          <InstallingPhase />
        )}
        {phase === 'results' && (
          <ResultsPhase
            deps={deps}
            onRetry={handleRetry}
            onContinue={onContinue}
          />
        )}
      </div>
    </div>
  )
}
