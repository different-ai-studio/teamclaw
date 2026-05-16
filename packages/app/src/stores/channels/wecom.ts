import type {
  WeComConfig,
  WeComGatewayStatusResponse,
  WeComQrAuthStart,
  WeComQrAuthPollResult,
  ChannelsState,
} from '../channels-types'
import { defaultWeComConfig } from '../channels-types'
import {
  listChannels,
  saveChannelConfig,
  reloadChannels,
  AmuxdUnreachableError,
} from '@/lib/amuxd-channels'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

function statusFor(platform: 'wecom', list: Awaited<ReturnType<typeof listChannels>>): WeComGatewayStatusResponse {
  const entry = list.find((c) => c.platform === platform)
  if (!entry) return { status: 'disconnected' }
  if (entry.lastError) return { status: 'error', errorMessage: entry.lastError }
  if (entry.connected) return { status: 'connected' }
  if (entry.enabled) return { status: 'connecting' }
  return { status: 'disconnected' }
}

function describe(e: unknown): string {
  if (e instanceof AmuxdUnreachableError) return 'amuxd not running. Start amuxd and try again.'
  return e instanceof Error ? e.message : String(e)
}

export function createWecomActions(set: ChannelsSet) {
  return {
    loadWecomConfig: async () => {
      set({ wecomIsLoading: true })
      try {
        const list = await listChannels()
        set({
          // amuxd does not expose the persisted config — keep defaults locally
          // until the user saves an explicit config.
          wecom: defaultWeComConfig,
          wecomGatewayStatus: statusFor('wecom', list),
          wecomIsLoading: false,
        })
      } catch (e) {
        console.error('[WeCom] Failed to load config:', e)
        set({ wecomIsLoading: false, error: describe(e) })
      }
    },

    saveWecomConfig: async (config: WeComConfig) => {
      try {
        await saveChannelConfig('wecom', config)
        await reloadChannels()
        set({ wecom: config, wecomHasChanges: false })
      } catch (e) {
        console.error('[WeCom] Failed to save config:', e)
        set({ error: describe(e) })
      }
    },

    startWecomGateway: async () => {
      const current = (await (async () => null as WeComConfig | null)()) // placeholder for type
      void current
      try {
        // Read latest config from store via a no-op set callback
        let cfg: WeComConfig = defaultWeComConfig
        set((state) => {
          cfg = state.wecom ?? defaultWeComConfig
          return {}
        })
        const enabled = { ...cfg, enabled: true }
        await saveChannelConfig('wecom', enabled)
        await reloadChannels()
        const list = await listChannels()
        set({ wecom: enabled, wecomGatewayStatus: statusFor('wecom', list) })
      } catch (e) {
        console.error('[WeCom] Failed to start gateway:', e)
        set({ wecomGatewayStatus: { status: 'error', errorMessage: describe(e) }, error: describe(e) })
      }
    },

    stopWecomGateway: async () => {
      try {
        let cfg: WeComConfig = defaultWeComConfig
        set((state) => {
          cfg = state.wecom ?? defaultWeComConfig
          return {}
        })
        const disabled = { ...cfg, enabled: false }
        await saveChannelConfig('wecom', disabled)
        await reloadChannels()
        set({ wecom: disabled, wecomGatewayStatus: { status: 'disconnected' } })
      } catch (e) {
        console.error('[WeCom] Failed to stop gateway:', e)
        set({ error: describe(e) })
      }
    },

    refreshWecomStatus: async () => {
      try {
        const list = await listChannels()
        set({ wecomGatewayStatus: statusFor('wecom', list) })
      } catch (e) {
        console.error('[WeCom] Failed to refresh status:', e)
      }
    },

    testWecomCredentials: async (_botId: string, _secret: string) => {
      // Credential probing is no longer a Tauri command — amuxd validates the
      // bot on startup. Save the config and watch the gateway status instead.
      set({
        wecomIsTesting: false,
        wecomTestResult: {
          success: false,
          message: 'Credential test is unavailable. Save the config — amuxd will validate it when the gateway starts.',
        },
      })
      return false
    },

    clearWecomTestResult: () => set({ wecomTestResult: null }),

    startWecomQrAuth: async (): Promise<WeComQrAuthStart> => {
      throw new Error('QR auth is no longer supported via the desktop app; configure WeCom credentials manually.')
    },

    pollWecomQrAuth: async (_scode: string): Promise<WeComQrAuthPollResult> => {
      throw new Error('QR auth is no longer supported via the desktop app.')
    },

    setWecomHasChanges: (hasChanges: boolean) => set({ wecomHasChanges: hasChanges }),

    toggleWecomEnabled: async (enabled: boolean, config: WeComConfig) => {
      const updatedConfig = { ...config, enabled }
      try {
        await saveChannelConfig('wecom', updatedConfig)
        await reloadChannels()
        set({ wecom: updatedConfig, wecomHasChanges: false })
        if (enabled) {
          set({ wecomIsLoading: true })
          // give amuxd a moment to reconcile, then fetch status
          await new Promise((resolve) => setTimeout(resolve, 1000))
          try {
            const list = await listChannels()
            set({ wecomGatewayStatus: statusFor('wecom', list), wecomIsLoading: false })
          } catch (error) {
            console.error('[WeCom] Status check after toggle failed:', error)
            set({ wecomIsLoading: false, error: describe(error) })
          }
        } else {
          set({ wecomGatewayStatus: { status: 'disconnected' } })
        }
      } catch (error) {
        console.error('[WeCom] Toggle enabled failed:', error)
        set({ error: describe(error) })
      }
    },
  }
}
