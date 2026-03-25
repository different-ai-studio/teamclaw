import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Key,
  Shield,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ExternalLink,
  Sparkles,
  Bot,
  BookOpen,
  ArrowRight,
  ArrowLeft,
  Zap,
} from 'lucide-react'
import { cn, openExternalUrl } from '@/lib/utils'
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
    id: 'create-bot',
    titleKey: 'settings.channels.wecom.wizardCreateTitle',
    title: 'Create WeCom AI Bot',
    descKey: 'settings.channels.wecom.wizardCreateDesc',
    description: 'Create an AI bot in WeCom Admin Console.',
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

  React.useEffect(() => {
    if (open) {
      setStep(0)
      setBotId(existingBotId || '')
      setSecret(existingSecret || '')
    }
  }, [open, existingBotId, existingSecret])

  const handleNext = () => {
    if (step < WECOM_WIZARD_STEPS.length - 1) {
      setStep(step + 1)
    }
  }

  const handleBack = () => {
    if (step > 0) {
      setStep(step - 1)
    }
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

      case 'create-bot':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
              <div className="flex items-start gap-3">
                <BookOpen className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5" />
                <div className="space-y-2 text-sm">
                  <p className="font-medium text-blue-900 dark:text-blue-100">{t('settings.channels.wecom.createBotSteps', 'Steps to create your WeCom AI bot')}:</p>
                  <ol className="list-decimal list-inside space-y-2 text-blue-800 dark:text-blue-200">
                    <li>{t('settings.channels.wecom.createBotStep1', 'Log in to WeCom Admin Console')}</li>
                    <li>{t('settings.channels.wecom.createBotStep2', 'Go to "Apps & Bots" → "AI Bots"')}</li>
                    <li>{t('settings.channels.wecom.createBotStep3', 'Click "Create Bot" and configure basic info')}</li>
                    <li>{t('settings.channels.wecom.createBotStep4', 'Enable "Long Connection" mode in bot settings')}</li>
                    <li>{t('settings.channels.wecom.createBotStep5', 'Copy the Bot ID and Secret')}</li>
                  </ol>
                </div>
              </div>
            </div>

            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => openExternalUrl('https://developer.work.weixin.qq.com/document/path/101463')}
            >
              <ExternalLink className="h-4 w-4" />
              {t('settings.channels.wecom.openDocs', 'Open WeCom AI Bot Documentation')}
            </Button>
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
    <Dialog open={open} onOpenChange={onOpenChange}>
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
              disabled={step === 2 && (!botId || !secret)}
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
