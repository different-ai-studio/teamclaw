import { invoke } from '@tauri-apps/api/core'
import type {
  KookConfig,
  KookGatewayStatusResponse,
  ChannelsState,
} from '../channels-types'
import { defaultKookConfig } from '../channels-types'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

export function createKookActions(set: ChannelsSet) {
  return {
    loadKookConfig: async () => {
      set({ kookIsLoading: true, error: null })
      try {
        const config = await invoke<KookConfig | null>('get_kook_config')
        const status = await invoke<KookGatewayStatusResponse>('get_kook_gateway_status')
        set({
          kook: config || defaultKookConfig,
          kookGatewayStatus: status,
          kookIsLoading: false,
          kookHasChanges: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          kookIsLoading: false,
        })
      }
    },

    saveKookConfig: async (config: KookConfig) => {
      set({ kookIsLoading: true, error: null })
      try {
        await invoke('save_kook_config', { kook: config })
        set({
          kook: config,
          kookIsLoading: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          kookIsLoading: false,
        })
        throw error
      }
    },

    startKookGateway: async () => {
      set({ kookIsLoading: true, error: null })
      try {
        await invoke('start_kook_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<KookGatewayStatusResponse>('get_kook_gateway_status')
        set({
          kookGatewayStatus: status,
          kookIsLoading: false,
          kookHasChanges: false,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        set({
          error: errorMessage,
          kookIsLoading: false,
          kookGatewayStatus: {
            status: 'error',
            errorMessage,
            connectedGuilds: [],
          },
        })
        throw error
      }
    },

    stopKookGateway: async () => {
      set({ kookIsLoading: true, error: null })
      try {
        await invoke('stop_kook_gateway')
        set({
          kookGatewayStatus: {
            status: 'disconnected',
            connectedGuilds: [],
          },
          kookIsLoading: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          kookIsLoading: false,
        })
        throw error
      }
    },

    refreshKookStatus: async () => {
      try {
        const status = await invoke<KookGatewayStatusResponse>('get_kook_gateway_status')
        set({ kookGatewayStatus: status })
      } catch (error) {
        console.error('[KOOK] Failed to refresh status:', error)
      }
    },

    testKookToken: async (token: string) => {
      set({ kookIsTesting: true, kookTestResult: null })
      try {
        const result = await invoke<string>('test_kook_token', { token })
        set({
          kookIsTesting: false,
          kookTestResult: { success: true, message: result },
        })
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        set({
          kookIsTesting: false,
          kookTestResult: { success: false, message },
        })
        return false
      }
    },

    clearKookTestResult: () => {
      set({ kookTestResult: null })
    },

    setKookHasChanges: (hasChanges: boolean) => {
      set({ kookHasChanges: hasChanges })
    },

    toggleKookEnabled: async (enabled: boolean, config: KookConfig) => {
      const updatedConfig = { ...config, enabled }
      try {
        await invoke('save_kook_config', { kook: updatedConfig })
        set({ kook: updatedConfig })
        if (enabled) {
          set({ kookIsLoading: true })
          try {
            await invoke('start_kook_gateway')
            await new Promise((resolve) => setTimeout(resolve, 1000))
            const status = await invoke<KookGatewayStatusResponse>('get_kook_gateway_status')
            set({ kookGatewayStatus: status, kookIsLoading: false, kookHasChanges: false })
          } catch (error) {
            console.error('[KOOK] Auto-start failed:', error)
            set({ kookIsLoading: false })
          }
        } else {
          try {
            await invoke('stop_kook_gateway')
            set({ kookGatewayStatus: { status: 'disconnected', connectedGuilds: [] } })
          } catch {
            // Ignore stop errors
          }
        }
      } catch (error) {
        console.error('[KOOK] Toggle enabled failed:', error)
      }
    },
  }
}
