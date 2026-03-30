import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Key,
  Shield,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Sparkles,
  Bot,
  ArrowRight,
  ArrowLeft,
  Zap,
  ScanQrCode,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { cn } from '@/lib/utils'
import { buildConfig } from '@/lib/build-config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  useChannelsStore,
  type WeComConfig,
  defaultWeComConfig,
} from '@/stores/channels'
import { WeComIcon } from './shared'
import { GatewayStatusCard } from './GatewayStatusCard'
import { TestCredentialsButton } from './TestCredentialsButton'
import { useChannelConfig } from '@/hooks/useChannelConfig'

// WeCom Setup Wizard
const WECOM_WIZARD_STEPS = [
  {
    id: 'intro',
    titleKey: 'settings.channels.wecom.wizardIntroTitle',
    title: 'Welcome to WeCom Setup',
    descKey: 'settings.channels.wecom.wizardIntroDesc',
    description: `Let's connect your WeCom AI bot to ${buildConfig.app.name} in a few simple steps.`,
  },
  {
    id: 'choose-method',
    titleKey: 'settings.channels.wecom.chooseMethod',
    title: 'Choose Setup Method',
    descKey: 'settings.channels.wecom.chooseMethodDesc',
    description: 'How would you like to set up your WeCom bot?',
  },
  {
    id: 'qr-scan',
    titleKey: 'settings.channels.wecom.scanTitle',
    title: 'Scan QR Code',
    descKey: 'settings.channels.wecom.scanDesc',
    description: 'Use WeCom to scan the QR code below.',
  },
  {
    id: 'get-credentials',
    titleKey: 'settings.channels.wecom.wizardCredentialsTitle',
    title: 'Get Your Bot Credentials',
    descKey: 'settings.channels.wecom.wizardCredentialsDesc',
    description: 'Copy your Bot ID and Secret.',
  },
  {
    id: 'complete',
    titleKey: 'settings.channels.wecom.wizardCompleteTitle',
    title: 'Setup Complete!',
    descKey: 'settings.channels.wecom.wizardCompleteDesc',
    description: 'Your WeCom bot is ready to use.',
  },
]

function WeComSetupWizard({
  open,
  onOpenChange,
  onCredentialsSave,
  existingBotId,
  existingSecret,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCredentialsSave: (botId: string, secret: string) => void
  existingBotId?: string
  existingSecret?: string
}) {
  const { t } = useTranslation()
  const [step, setStep] = React.useState(0)
  const [botId, setBotId] = React.useState(existingBotId || '')
  const [secret, setSecret] = React.useState(existingSecret || '')
  const [method, setMethod] = React.useState<'qr' | 'manual' | null>(null)
  const [qrAuthUrl, setQrAuthUrl] = React.useState<string | null>(null)
  const [_qrScode, setQrScode] = React.useState<string | null>(null)
  const [qrLoading, setQrLoading] = React.useState(false)
  const [qrError, setQrError] = React.useState<string>('')
  const [scanStatus, setScanStatus] = React.useState<string>('')
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const errorCountRef = React.useRef(0)

  const { startWecomQrAuth, pollWecomQrAuth } = useChannelsStore()

  const cleanupPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    errorCountRef.current = 0
  }

  React.useEffect(() => {
    if (open) {
      setStep(0)
      setBotId(existingBotId || '')
      setSecret(existingSecret || '')
      setMethod(null)
      setQrAuthUrl(null)
      setQrScode(null)
      setQrLoading(false)
      setQrError('')
      setScanStatus('')
      cleanupPolling()
    }
    return () => cleanupPolling()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const fetchQrCode = async () => {
    setQrLoading(true)
    setQrError('')
    setScanStatus('')
    cleanupPolling()
    try {
      const data = await startWecomQrAuth()
      setQrAuthUrl(data.auth_url)
      setQrScode(data.scode)
      setQrLoading(false)

      // Start polling
      pollRef.current = setInterval(async () => {
        try {
          const result = await pollWecomQrAuth(data.scode)
          errorCountRef.current = 0
          if (result.status === 'success' && result.botId && result.secret) {
            cleanupPolling()
            setScanStatus('success')
            setBotId(result.botId)
            setSecret(result.secret)
            // Advance to complete step — credentials saved on "Finish"
            setStep(WECOM_WIZARD_STEPS.findIndex(s => s.id === 'complete'))
          }
        } catch {
          errorCountRef.current++
          if (errorCountRef.current >= 3) {
            cleanupPolling()
            setQrError(t('settings.channels.wecom.scanError', 'Failed to get QR code. Please try again or use manual input.'))
          }
        }
      }, 3000)

      // Auto-expire after 5 minutes
      setTimeout(() => {
        if (pollRef.current) {
          cleanupPolling()
          setQrError(t('settings.channels.wecom.scanTimeout', 'QR code expired. Please try again.'))
          setQrAuthUrl(null)
        }
      }, 300000)
    } catch (e) {
      setQrLoading(false)
      setQrError(String(e))
    }
  }

  const handleNext = () => {
    const currentId = WECOM_WIZARD_STEPS[step]?.id
    if (currentId === 'choose-method') {
      if (method === 'qr') {
        const qrStep = WECOM_WIZARD_STEPS.findIndex(s => s.id === 'qr-scan')
        setStep(qrStep)
        // Auto-fetch QR code when entering scan step
        setTimeout(() => fetchQrCode(), 100)
      } else {
        const manualStep = WECOM_WIZARD_STEPS.findIndex(s => s.id === 'get-credentials')
        setStep(manualStep)
      }
    } else if (step < WECOM_WIZARD_STEPS.length - 1) {
      setStep(step + 1)
    }
  }

  const handleBack = () => {
    const currentId = WECOM_WIZARD_STEPS[step]?.id
    if (currentId === 'qr-scan' || currentId === 'get-credentials') {
      cleanupPolling()
      setQrAuthUrl(null)
      setQrError('')
      setStep(WECOM_WIZARD_STEPS.findIndex(s => s.id === 'choose-method'))
    } else if (step > 0) {
      setStep(step - 1)
    }
  }

  const handleClose = () => {
    cleanupPolling()
    onOpenChange(false)
  }

  const handleComplete = () => {
    if (botId.trim() && secret.trim()) {
      onCredentialsSave(botId.trim(), secret.trim())
    }
    onOpenChange(false)
  }

  const currentStep = WECOM_WIZARD_STEPS[step]

  const renderStepContent = () => {
    switch (currentStep.id) {
      case 'intro':
        return (
          <div className="space-y-6">
            <div className="flex justify-center">
              <div className="relative">
                <div className="rounded-2xl p-6 bg-gradient-to-br from-blue-100 to-cyan-100 dark:from-blue-900/50 dark:to-cyan-900/50">
                  <Bot className="h-16 w-16 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="absolute -right-2 -top-2 rounded-full bg-emerald-500 p-2">
                  <Sparkles className="h-4 w-4 text-white" />
                </div>
              </div>
            </div>

            <div className="text-center space-y-2">
              <h3 className="text-lg font-semibold">{t('settings.channels.wecom.connectTitle', { defaultValue: 'Connect WeCom to {{appName}}', appName: buildConfig.app.name })}</h3>
              <p className="text-sm text-muted-foreground">
                {t('settings.channels.wecom.connectDesc', { defaultValue: "This wizard will guide you through creating a WeCom AI bot and connecting it to {{appName}}. You'll be able to interact with AI directly from WeCom chats.", appName: buildConfig.app.name })}
              </p>
            </div>

            <div className="grid gap-3">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                <div className="rounded-full bg-blue-100 dark:bg-blue-900/50 p-2">
                  <Zap className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="text-sm font-medium">{t('settings.channels.quickSetup', 'Quick Setup')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.quickSetupDesc', 'Complete in about 5 minutes')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/50 p-2">
                  <Shield className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-medium">{t('settings.channels.wecom.longConnection', 'Long Connection')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.channels.wecom.longConnectionDesc', 'No public server needed, runs locally via WebSocket')}</p>
                </div>
              </div>
            </div>
          </div>
        )

      case 'choose-method':
        return (
          <div className="space-y-4">
            <div
              className={cn(
                "p-4 rounded-lg border-2 cursor-pointer transition-colors",
                method === 'qr'
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                  : "border-muted hover:border-blue-300"
              )}
              onClick={() => setMethod('qr')}
            >
              <div className="flex items-center gap-3">
                <div className="rounded-lg p-2 bg-blue-100 dark:bg-blue-900/50">
                  <ScanQrCode className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{t('settings.channels.wecom.qrScan', 'QR Code Scan')}</p>
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300">
                      {t('settings.channels.wecom.qrScanRecommended', 'Recommended')}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{t('settings.channels.wecom.qrScanDesc', 'Scan with WeCom to auto-create bot')}</p>
                </div>
              </div>
            </div>

            <div
              className={cn(
                "p-4 rounded-lg border-2 cursor-pointer transition-colors",
                method === 'manual'
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                  : "border-muted hover:border-blue-300"
              )}
              onClick={() => setMethod('manual')}
            >
              <div className="flex items-center gap-3">
                <div className="rounded-lg p-2 bg-muted">
                  <Key className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium">{t('settings.channels.wecom.manualInput', 'Manual Input')}</p>
                  <p className="text-sm text-muted-foreground">{t('settings.channels.wecom.manualInputDesc', 'Already have Bot ID and Secret')}</p>
                </div>
              </div>
            </div>
          </div>
        )

      case 'qr-scan':
        return (
          <div className="space-y-4">
            {!qrAuthUrl && !qrLoading && !qrError && (
              <div className="text-center space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t('settings.channels.wecom.scanInstructions', 'Open WeCom on your phone and scan this QR code to authorize.')}
                </p>
                <Button onClick={fetchQrCode} className="gap-2">
                  <Sparkles className="h-4 w-4" />
                  {t('settings.channels.wecom.getQrCode', 'Get QR Code')}
                </Button>
              </div>
            )}

            {qrLoading && (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                <p className="text-sm text-muted-foreground">{t('settings.channels.wecom.loadingQr', 'Generating QR code...')}</p>
              </div>
            )}

            {qrAuthUrl && !qrLoading && (
              <div className="flex flex-col items-center space-y-4">
                <div className="p-4 bg-white rounded-xl shadow-sm border">
                  <QRCodeSVG value={qrAuthUrl} size={200} level="M" />
                </div>
                <p className="text-sm text-muted-foreground text-center">
                  {t('settings.channels.wecom.scanInstructions', 'Open WeCom on your phone and scan this QR code to authorize.')}
                </p>
                {scanStatus !== 'success' && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('settings.channels.wecom.waitingScan', 'Waiting for scan...')}
                  </div>
                )}
                {scanStatus === 'success' && (
                  <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" />
                    {t('settings.channels.wecom.scanSuccess', 'Authorization successful! Credentials obtained.')}
                  </div>
                )}
              </div>
            )}

            {qrError && (
              <div className="text-center space-y-3">
                <div className="flex items-center justify-center gap-2 text-sm text-red-600">
                  <AlertCircle className="h-4 w-4" />
                  {qrError}
                </div>
                <div className="flex justify-center gap-2">
                  <Button variant="outline" onClick={fetchQrCode} size="sm" className="gap-1">
                    {t('settings.channels.wecom.retryQr', 'Retry')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setMethod('manual')
                      setQrError('')
                      setStep(WECOM_WIZARD_STEPS.findIndex(s => s.id === 'get-credentials'))
                    }}
                  >
                    {t('settings.channels.wecom.switchToManual', 'Switch to Manual Input')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )

      case 'get-credentials':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium text-amber-900 dark:text-amber-100">{t('settings.channels.wecom.credentialsSecretWarning', 'Keep your credentials secret!')}</p>
                  <p className="text-amber-800 dark:text-amber-200">
                    {t('settings.channels.wecom.credentialsSecretDesc', 'Never share your Bot Secret. It is stored locally on your device.')}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t('settings.channels.wecom.credentialsPortalHint', 'In the WeCom Admin Console, go to your AI Bot settings:')}
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings.channels.wecom.botId', 'Bot ID')}</label>
              <Input
                value={botId}
                onChange={(e) => setBotId(e.target.value)}
                placeholder={t('settings.channels.wecom.botIdPlaceholder', 'Enter your WeCom bot ID')}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings.channels.wecom.secret', 'Secret')}</label>
              <div className="relative">
                <Input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={t('settings.channels.wecom.secretPlaceholder', 'Enter your WeCom bot secret')}
                  className="pr-10"
                />
                <Key className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              </div>
            </div>

            {botId && secret && (
              <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                {t('settings.channels.wecom.credentialsEntered', 'Credentials entered')}
              </div>
            )}
          </div>
        )

      case 'complete':
        return (
          <div className="space-y-6 text-center">
            <div className="flex justify-center">
              <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/50 p-6">
                <CheckCircle2 className="h-12 w-12 text-emerald-600 dark:text-emerald-400" />
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-lg font-semibold">{t('settings.channels.allSet', "You're all set!")}</h3>
              <p className="text-sm text-muted-foreground">
                {t('settings.channels.wecom.completeMessage', 'Your WeCom bot is now configured. Click "Finish" to save your settings and start using the bot.')}
              </p>
            </div>

            <div className="p-4 rounded-lg bg-muted/50 text-left space-y-2">
              <p className="text-sm font-medium">{t('settings.channels.nextSteps', 'Next steps:')}</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• {t('settings.channels.nextStepConnect', 'Enable the gateway toggle to connect')}</li>
                <li>• {t('settings.channels.wecom.nextStepMessage', 'Send a message to your bot in WeCom to test!')}</li>
              </ul>
            </div>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-500" />
            {t(currentStep.titleKey, currentStep.title)}
          </DialogTitle>
          <DialogDescription>
            {t(currentStep.descKey, currentStep.description)}
          </DialogDescription>
        </DialogHeader>

        {/* Progress Indicator */}
        <div className="flex items-center gap-1 py-2">
          {WECOM_WIZARD_STEPS.map((s, i) => (
            <div
              key={s.id}
              className={cn(
                "flex-1 h-1.5 rounded-full transition-colors",
                i <= step ? "bg-blue-500" : "bg-muted"
              )}
            />
          ))}
        </div>

        <div className="py-4 min-h-[300px] overflow-hidden">
          {renderStepContent()}
        </div>

        <DialogFooter className="flex-row gap-2 sm:gap-2">
          {step > 0 && step < WECOM_WIZARD_STEPS.length - 1 && (
            <Button variant="outline" onClick={handleBack} className="gap-1">
              <ArrowLeft className="h-4 w-4" />
              {t('settings.channels.back', 'Back')}
            </Button>
          )}
          <div className="flex-1" />
          {step === 0 && (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('settings.channels.cancel', 'Cancel')}
            </Button>
          )}
          {step < WECOM_WIZARD_STEPS.length - 1 ? (
            <Button
              onClick={handleNext}
              className="gap-1"
              disabled={
                (WECOM_WIZARD_STEPS[step]?.id === 'choose-method' && !method) ||
                (WECOM_WIZARD_STEPS[step]?.id === 'get-credentials' && (!botId || !secret)) ||
                WECOM_WIZARD_STEPS[step]?.id === 'qr-scan'
              }
            >
              {t('settings.channels.next', 'Next')}
              <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={handleComplete} className="gap-2">
              <Sparkles className="h-4 w-4" />
              {t('settings.channels.finishSetup', 'Finish Setup')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function WeComChannel() {
  const { t } = useTranslation()
  const {
    wecom,
    wecomIsLoading,
    wecomGatewayStatus,
    wecomHasChanges,
    wecomIsTesting,
    wecomTestResult,
    loadWecomConfig,
    saveWecomConfig,
    startWecomGateway,
    stopWecomGateway,
    refreshWecomStatus,
    testWecomCredentials,
    clearWecomTestResult,
    setWecomHasChanges,
    toggleWecomEnabled,
  } = useChannelsStore()

  const [expanded, setExpanded] = React.useState(false)
  const [wizardOpen, setWizardOpen] = React.useState(false)

  React.useEffect(() => {
    loadWecomConfig()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const {
    localConfig,
    updateLocalConfig,
    isConnecting,
    isRunning,
    handleSave,
    handleStartStop,
    handleRestart,
  } = useChannelConfig<WeComConfig>({
    storeConfig: wecom,
    defaultConfig: defaultWeComConfig,
    gatewayStatus: wecomGatewayStatus,
    isLoading: wecomIsLoading,
    hasChanges: wecomHasChanges,
    setHasChanges: setWecomHasChanges,
    saveConfig: saveWecomConfig,
    startGateway: startWecomGateway,
    stopGateway: stopWecomGateway,
    refreshStatus: refreshWecomStatus,
  })

  const handleTestCredentials = async () => {
    if (!localConfig.botId || !localConfig.secret) return
    await testWecomCredentials(localConfig.botId, localConfig.secret)
  }

  const handleWizardSave = (botId: string, secret: string) => {
    updateLocalConfig({ botId, secret, enabled: true })
    setWecomHasChanges(true)
  }

  return (
    <>
      <GatewayStatusCard
        icon={
          <div className="rounded-lg p-2 bg-blue-100 dark:bg-blue-900/50">
            <WeComIcon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          </div>
        }
        title={t('settings.channels.wecom.gateway', 'WeCom Gateway')}
        status={wecomGatewayStatus.status}
        statusDetail={
          wecomGatewayStatus.botId ? (
            <p className="text-sm text-muted-foreground">
              Bot: {wecomGatewayStatus.botId}
            </p>
          ) : undefined
        }
        errorMessage={wecomGatewayStatus.errorMessage}
        expanded={expanded}
        onToggleExpanded={() => setExpanded(!expanded)}
        enabled={localConfig.enabled}
        onToggleEnabled={(enabled) => {
          updateLocalConfig({ enabled })
          toggleWecomEnabled(enabled, { ...localConfig, enabled })
        }}
        isLoading={wecomIsLoading}
        isConnecting={isConnecting}
        isRunning={isRunning}
        hasChanges={wecomHasChanges}
        onStartStop={handleStartStop}
        onRestart={handleRestart}
        startDisabled={!localConfig.botId || !localConfig.secret}
        onOpenWizard={() => setWizardOpen(true)}
      >
        {/* Setup Wizard Prompt - Show when no credentials */}
        {!localConfig.botId && (
          <div className="p-4 rounded-lg bg-gradient-to-br from-blue-50 to-cyan-50 dark:from-blue-950/30 dark:to-cyan-950/30 border border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-4">
              <Bot className="h-8 w-8 text-blue-600 dark:text-blue-400 flex-shrink-0" />
              <div className="flex-1">
                <h4 className="font-semibold text-blue-900 dark:text-blue-100">
                  {t('settings.channels.wecom.setupTitle', 'Set up WeCom Integration')}
                </h4>
                <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                  {t('settings.channels.wecom.setupDesc', 'Connect a WeCom AI bot to interact with AI from WeCom chats.')}
                </p>
              </div>
              <Button onClick={() => setWizardOpen(true)} size="sm" className="gap-2 flex-shrink-0">
                <Sparkles className="h-4 w-4" />
                {t('settings.channels.startSetup', 'Start Setup')}
              </Button>
            </div>
          </div>
        )}

        {/* Bot Credentials */}
        <div className="space-y-2">
          <label className="text-sm font-medium flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground" />
            {t('settings.channels.wecom.botCredentials', 'Bot Credentials')}
          </label>
          <div className="space-y-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('settings.channels.wecom.botId', 'Bot ID')}</label>
              <Input
                value={localConfig.botId}
                onChange={(e) => updateLocalConfig({ botId: e.target.value })}
                placeholder={t('settings.channels.wecom.botIdPlaceholder', 'Enter your WeCom bot ID')}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('settings.channels.wecom.secret', 'Secret')}</label>
              <div className="flex flex-wrap gap-2">
                <div className="relative flex-1">
                  <Input
                    type="password"
                    value={localConfig.secret}
                    onChange={(e) => updateLocalConfig({ secret: e.target.value })}
                    placeholder={t('settings.channels.wecom.secretPlaceholder', 'Enter your WeCom bot secret')}
                    className="pr-10"
                  />
                  <Shield className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                </div>
                <TestCredentialsButton
                  onTest={handleTestCredentials}
                  isTesting={wecomIsTesting}
                  testResult={wecomTestResult}
                  onClearResult={clearWecomTestResult}
                  disabled={!localConfig.botId || !localConfig.secret}
                />
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Shield className="h-3 w-3" />
            {t('settings.channels.credentialsStoredLocally', 'Your credentials are stored locally and never sent to our servers.')}
          </p>
        </div>

        {/* Encoding AES Key (optional) */}
        <div className="space-y-2">
          <label className="text-sm font-medium flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground" />
            {t('settings.channels.wecom.encodingAesKey', 'Encoding AES Key')}
            <span className="text-xs text-muted-foreground font-normal">({t('settings.channels.optional', 'optional')})</span>
          </label>
          <Input
            type="password"
            value={localConfig.encodingAesKey || ''}
            onChange={e => updateLocalConfig({ encodingAesKey: e.target.value || undefined })}
            placeholder={t('settings.channels.wecom.encodingAesKeyPlaceholder', '43-character key for attachment decryption')}
          />
        </div>

        {/* Error message */}
        {wecomGatewayStatus.errorMessage && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/30 p-3 rounded-lg border border-red-200 dark:border-red-800">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {wecomGatewayStatus.errorMessage}
          </div>
        )}

        {/* Save Button */}
        <Button
          className="w-full gap-2"
          onClick={handleSave}
          disabled={wecomIsLoading}
        >
          {wecomIsLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('settings.channels.saving', 'Saving...')}
            </>
          ) : (
            t('settings.channels.saveChanges', 'Save Changes')
          )}
        </Button>
      </GatewayStatusCard>

      {/* WeCom Setup Wizard */}
      <WeComSetupWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCredentialsSave={handleWizardSave}
        existingBotId={localConfig.botId}
        existingSecret={localConfig.secret}
      />
    </>
  )
}
