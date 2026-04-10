import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Smartphone,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Trash2,
  RefreshCw,
  Play,
  Square,
  Hash,
  QrCode,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SectionHeader } from './shared/SectionHeader'
import { SettingCard } from './shared/SettingCard'

// ---- Types ----

interface MqttRelayConfig {
  brokerHost: string
  brokerPort: number
  username: string
  password: string
  teamId: string
  deviceId: string
  deviceName: string
  pairedDevices: PairedDevice[]
}

interface PairedDevice {
  deviceId: string
  deviceName: string
  pairedAt?: number
}

interface MqttRelayStatus {
  connected: boolean
  brokerHost?: string
  pairedDeviceCount: number
  errorMessage?: string
}

const defaultConfig: MqttRelayConfig = {
  brokerHost: '',
  brokerPort: 8883,
  username: '',
  password: '',
  teamId: '',
  deviceId: '',
  deviceName: '',
  pairedDevices: [],
}

// ---- Connection Status Badge ----

function ConnectionStatus({ connected }: { connected: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={connected
          ? 'h-2 w-2 rounded-full bg-emerald-500'
          : 'h-2 w-2 rounded-full bg-red-500'}
      />
      <span className={connected
        ? 'text-xs text-emerald-600 dark:text-emerald-400'
        : 'text-xs text-red-600 dark:text-red-400'}>
        {connected
          ? t('settings.mobileRelay.connected', 'Connected')
          : t('settings.mobileRelay.disconnected', 'Disconnected')}
      </span>
    </div>
  )
}

// ---- Main Component ----

export function MobileRelaySettings() {
  const { t } = useTranslation()

  // Config state
  const [config, setConfig] = React.useState<MqttRelayConfig>(defaultConfig)
  const [isLoadingConfig, setIsLoadingConfig] = React.useState(false)
  const [isSaving, setIsSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = React.useState(false)

  // Status state
  const [status, setStatus] = React.useState<MqttRelayStatus>({ connected: false, pairedDeviceCount: 0 })
  const [isStarting, setIsStarting] = React.useState(false)
  const [isStopping, setIsStopping] = React.useState(false)
  const [statusError, setStatusError] = React.useState<string | null>(null)

  // Pairing code state
  const [pairingCode, setPairingCode] = React.useState<string | null>(null)
  const [isGeneratingCode, setIsGeneratingCode] = React.useState(false)
  const [pairingError, setPairingError] = React.useState<string | null>(null)

  // Unpair state
  const [unpairingId, setUnpairingId] = React.useState<string | null>(null)

  // Load config on mount
  React.useEffect(() => {
    loadConfig()
    loadStatus()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll status + config every 5s so paired devices appear automatically after pairing
  React.useEffect(() => {
    const interval = setInterval(async () => {
      await loadStatus()
      await loadConfig()
    }, 5000)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadConfig = async () => {
    setIsLoadingConfig(true)
    try {
      const cfg = await invoke<MqttRelayConfig>('get_mqtt_relay_config')
      setConfig(cfg)
    } catch {
      // Config may not exist yet — use defaults
    } finally {
      setIsLoadingConfig(false)
    }
  }

  const loadStatus = async () => {
    try {
      const s = await invoke<MqttRelayStatus>('get_mqtt_relay_status')
      setStatus(s)
      setStatusError(s.errorMessage ?? null)
    } catch {
      // Ignore polling errors silently
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    setSaveError(null)
    setSaveSuccess(false)
    try {
      await invoke('save_mqtt_relay_config', { config })
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
    } catch (e) {
      setSaveError(String(e))
    } finally {
      setIsSaving(false)
    }
  }

  const handleStart = async () => {
    setIsStarting(true)
    setStatusError(null)
    try {
      await invoke('start_mqtt_relay')
      await loadStatus()
    } catch (e) {
      setStatusError(String(e))
    } finally {
      setIsStarting(false)
    }
  }

  const handleStop = async () => {
    setIsStopping(true)
    try {
      await invoke('stop_mqtt_relay')
      await loadStatus()
    } catch (e) {
      setStatusError(String(e))
    } finally {
      setIsStopping(false)
    }
  }

  const handleGeneratePairingCode = async () => {
    setIsGeneratingCode(true)
    setPairingError(null)
    setPairingCode(null)
    try {
      const code = await invoke<string>('generate_mqtt_pairing_code')
      setPairingCode(code)
    } catch (e) {
      setPairingError(String(e))
    } finally {
      setIsGeneratingCode(false)
    }
  }

  const handleUnpair = async (deviceId: string) => {
    setUnpairingId(deviceId)
    try {
      await invoke('unpair_mqtt_device', { deviceId })
      await loadConfig()
      await loadStatus()
    } catch {
      // Ignore
    } finally {
      setUnpairingId(null)
    }
  }

  const updateConfig = (updates: Partial<MqttRelayConfig>) => {
    setConfig(prev => ({ ...prev, ...updates }))
  }

  const isRunning = status.connected
  const isActing = isStarting || isStopping

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Smartphone}
        title={t('settings.mobileRelay.title', 'Mobile Relay')}
        description={t('settings.mobileRelay.description', 'Connect your mobile device to receive and send messages via MQTT broker')}
        iconColor="text-cyan-500"
      />

      {/* Connection Status Card */}
      <SettingCard>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="rounded-lg p-2 bg-cyan-100 dark:bg-cyan-900/50">
              <Smartphone className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{t('settings.mobileRelay.gatewayTitle', 'MQTT Mobile Gateway')}</span>
                <ConnectionStatus connected={status.connected} />
              </div>
              {statusError && (
                <p className="text-xs text-red-500 mt-0.5">{statusError}</p>
              )}
            </div>
          </div>
          <Button
            variant={isRunning ? 'destructive' : 'default'}
            size="sm"
            onClick={isRunning ? handleStop : handleStart}
            disabled={isActing || isLoadingConfig}
            className="gap-2"
          >
            {isActing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isRunning ? (
              <>
                <Square className="h-4 w-4" />
                {t('settings.mobileRelay.stop', 'Stop')}
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                {t('settings.mobileRelay.start', 'Start')}
              </>
            )}
          </Button>
        </div>
      </SettingCard>

      {/* Configuration Form */}
      <SettingCard>
        <div className="space-y-4">
          <h4 className="font-medium text-sm">{t('settings.mobileRelay.brokerConfig', 'Broker Configuration')}</h4>

          {/* Broker host + port */}
          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <label className="text-xs text-muted-foreground">
                {t('settings.mobileRelay.brokerHost', 'Broker Host')}
              </label>
              <Input
                value={config.brokerHost}
                onChange={e => updateConfig({ brokerHost: e.target.value })}
                placeholder="mqtt.example.com"
                disabled={isLoadingConfig}
              />
            </div>
            <div className="w-28 space-y-1">
              <label className="text-xs text-muted-foreground">
                {t('settings.mobileRelay.brokerPort', 'Port')}
              </label>
              <Input
                type="number"
                value={config.brokerPort}
                onChange={e => updateConfig({ brokerPort: parseInt(e.target.value, 10) || 1883 })}
                placeholder="1883"
                disabled={isLoadingConfig}
              />
            </div>
          </div>

          {/* Username + password */}
          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <label className="text-xs text-muted-foreground">
                {t('settings.mobileRelay.username', 'Username')}
              </label>
              <Input
                value={config.username}
                onChange={e => updateConfig({ username: e.target.value })}
                placeholder={t('settings.mobileRelay.usernamePlaceholder', 'Optional')}
                disabled={isLoadingConfig}
              />
            </div>
            <div className="flex-1 space-y-1">
              <label className="text-xs text-muted-foreground">
                {t('settings.mobileRelay.password', 'Password')}
              </label>
              <Input
                type="password"
                value={config.password}
                onChange={e => updateConfig({ password: e.target.value })}
                placeholder={t('settings.mobileRelay.passwordPlaceholder', 'Optional')}
                disabled={isLoadingConfig}
              />
            </div>
          </div>

          {/* Team ID + device name */}
          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <label className="text-xs text-muted-foreground">
                {t('settings.mobileRelay.teamId', 'Team ID')}
              </label>
              <Input
                value={config.teamId}
                onChange={e => updateConfig({ teamId: e.target.value })}
                placeholder={t('settings.mobileRelay.teamIdPlaceholder', 'Your team identifier')}
                disabled={isLoadingConfig}
              />
            </div>
            <div className="flex-1 space-y-1">
              <label className="text-xs text-muted-foreground">
                {t('settings.mobileRelay.deviceName', 'Device Name')}
              </label>
              <Input
                value={config.deviceName}
                onChange={e => updateConfig({ deviceName: e.target.value })}
                placeholder={t('settings.mobileRelay.deviceNamePlaceholder', 'e.g. My Mac')}
                disabled={isLoadingConfig}
              />
            </div>
          </div>

          {/* Save error */}
          {saveError && (
            <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/30 p-3 rounded-lg border border-red-200 dark:border-red-800">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {saveError}
            </div>
          )}

          {/* Save button */}
          <Button
            className="w-full gap-2"
            onClick={handleSave}
            disabled={isSaving || isLoadingConfig}
          >
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('settings.mobileRelay.saving', 'Saving...')}
              </>
            ) : saveSuccess ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                {t('settings.mobileRelay.saved', 'Saved!')}
              </>
            ) : (
              t('settings.mobileRelay.save', 'Save Configuration')
            )}
          </Button>
        </div>
      </SettingCard>

      {/* Pairing Code */}
      <SettingCard>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-sm">{t('settings.mobileRelay.pairingTitle', 'Pair Mobile Device')}</h4>
            <Button
              variant="outline"
              size="sm"
              onClick={handleGeneratePairingCode}
              disabled={isGeneratingCode}
              className="gap-2"
            >
              {isGeneratingCode ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t('settings.mobileRelay.generateCode', 'Generate Pairing Code')}
            </Button>
          </div>

          {pairingError && (
            <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/30 p-3 rounded-lg border border-red-200 dark:border-red-800">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {pairingError}
            </div>
          )}

          {pairingCode ? (
            <div className="flex flex-col items-center gap-4 py-4">
              <p className="text-sm text-muted-foreground">
                {t('settings.mobileRelay.pairingQrHint', 'Scan this QR code with the mobile app to pair:')}
              </p>
              <div className="p-4 rounded-xl bg-white">
                <QRCodeSVG
                  value={JSON.stringify({
                    host: config.brokerHost,
                    port: config.brokerPort,
                    user: config.username || undefined,
                    pass: config.password || undefined,
                    code: pairingCode,
                  })}
                  size={180}
                  level="H"
                  imageSettings={{
                    src: '/logo-64.png',
                    x: undefined,
                    y: undefined,
                    height: 36,
                    width: 36,
                    excavate: true,
                  }}
                />
              </div>
              <div className="flex items-center gap-2 px-6 py-3 rounded-xl bg-muted border-2 border-dashed border-primary/30">
                <Hash className="h-5 w-5 text-muted-foreground" />
                <span className="text-4xl font-mono font-bold tracking-widest text-primary select-all">
                  {pairingCode}
                </span>
              </div>
              <p className="text-xs text-muted-foreground text-center">
                {t('settings.mobileRelay.pairingCodeExpiry', 'This code expires after a short time. Generate a new one if needed.')}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              {t('settings.mobileRelay.noPairingCode', 'Click "Generate Pairing Code" to begin pairing a mobile device.')}
            </p>
          )}
        </div>
      </SettingCard>

      {/* Paired Devices */}
      <SettingCard>
        <div className="space-y-4">
          <h4 className="font-medium text-sm">{t('settings.mobileRelay.pairedDevices', 'Paired Devices')}</h4>

          {config.pairedDevices.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              {t('settings.mobileRelay.noDevices', 'No paired devices yet.')}
            </p>
          ) : (
            <div className="space-y-2">
              {config.pairedDevices.map(device => (
                <div
                  key={device.deviceId}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border"
                >
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg p-1.5 bg-background border">
                      <Smartphone className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{device.deviceName || device.deviceId}</p>
                      {device.pairedAt && (
                        <p className="text-xs text-muted-foreground">
                          {t('settings.mobileRelay.pairedAt', 'Paired')}: {new Date(device.pairedAt * 1000).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleUnpair(device.deviceId)}
                    disabled={unpairingId === device.deviceId}
                    className="gap-2 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                  >
                    {unpairingId === device.deviceId ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    {t('settings.mobileRelay.unpair', '解除配对')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingCard>
    </div>
  )
}
