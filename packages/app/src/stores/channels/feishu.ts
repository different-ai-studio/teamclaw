import { invoke } from '@tauri-apps/api/core'
import type {
  FeishuConfig,
  FeishuGatewayStatusResponse,
  ChannelsState,
} from '../channels-types'
import { defaultFeishuConfig } from '../channels-types'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

export function createFeishuActions(set: ChannelsSet) {
  return {
    loadFeishuConfig: async () => {
      set({ feishuIsLoading: true, error: null })
      try {
        const config = await invoke<FeishuConfig | null>('get_feishu_config')
        const status = await invoke<FeishuGatewayStatusResponse>('get_feishu_gateway_status')
        set({
          feishu: config || defaultFeishuConfig,
          feishuGatewayStatus: status,
          feishuIsLoading: false,
          feishuHasChanges: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          feishuIsLoading: false,
        })
      }
    },

    saveFeishuConfig: async (config: FeishuConfig) => {
      set({ feishuIsLoading: true, error: null })
      try {
        await invoke('save_feishu_config', { feishu: config })
        set({
          feishu: config,
          feishuIsLoading: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          feishuIsLoading: false,
        })
        throw error
      }
    },

    startFeishuGateway: async () => {
      set({ feishuIsLoading: true, error: null })
      try {
        await invoke('start_feishu_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<FeishuGatewayStatusResponse>('get_feishu_gateway_status')
        set({
          feishuGatewayStatus: status,
          feishuIsLoading: false,
          feishuHasChanges: false,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        set({
          error: errorMessage,
          feishuIsLoading: false,
          feishuGatewayStatus: {
            status: 'error',
            errorMessage,
          },
        })
        throw error
      }
    },

    stopFeishuGateway: async () => {
      set({ feishuIsLoading: true, error: null })
      try {
        await invoke('stop_feishu_gateway')
        set({
          feishuGatewayStatus: {
            status: 'disconnected',
          },
          feishuIsLoading: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          feishuIsLoading: false,
        })
        throw error
      }
    },

    refreshFeishuStatus: async () => {
      try {
        const status = await invoke<FeishuGatewayStatusResponse>('get_feishu_gateway_status')
        set({ feishuGatewayStatus: status })
      } catch (error) {
        console.error('Failed to refresh Feishu gateway status:', error)
      }
    },

    testFeishuCredentials: async (appId: string, appSecret: string) => {
      set({ feishuIsTesting: true, feishuTestResult: null })
      try {
        await invoke<string>('test_feishu_credentials', { appId, appSecret })
        set({
          feishuIsTesting: false,
          feishuTestResult: {
            success: true,
            message: 'Credentials valid',
          },
        })
        return true
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        set({
          feishuIsTesting: false,
          feishuTestResult: {
            success: false,
            message: errorMessage,
          },
        })
        return false
      }
    },

    clearFeishuTestResult: () => set({ feishuTestResult: null }),
    setFeishuHasChanges: (hasChanges: boolean) => set({ feishuHasChanges: hasChanges }),

    toggleFeishuEnabled: async (enabled: boolean, config: FeishuConfig) => {
      const updatedConfig = { ...config, enabled }
      try {
        await invoke('save_feishu_config', { feishu: updatedConfig })
        set({ feishu: updatedConfig })
        if (enabled) {
          set({ feishuIsLoading: true })
          try {
            await invoke('start_feishu_gateway')
            await new Promise((resolve) => setTimeout(resolve, 1000))
            const status = await invoke<FeishuGatewayStatusResponse>('get_feishu_gateway_status')
            set({ feishuGatewayStatus: status, feishuIsLoading: false, feishuHasChanges: false })
          } catch (error) {
            console.error('[Feishu] Auto-start failed:', error)
            set({ feishuIsLoading: false })
          }
        } else {
          try {
            await invoke('stop_feishu_gateway')
            set({ feishuGatewayStatus: { status: 'disconnected' } })
          } catch {
            // May not be running
          }
        }
      } catch (error) {
        console.error('[Feishu] Toggle enabled failed:', error)
      }
    },
  }
}
