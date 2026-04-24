import { invoke } from '@tauri-apps/api/core'
import { useWorkspaceStore } from '@/stores/workspace'
import type {
  WeComConfig,
  WeComGatewayStatusResponse,
  WeComQrAuthStart,
  WeComQrAuthPollResult,
  ChannelsState,
} from '../channels-types'
import { defaultWeComConfig } from '../channels-types'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

function getWorkspaceArgs() {
  const workspacePath = useWorkspaceStore.getState().workspacePath
  return workspacePath ? { workspacePath } : {}
}

export function createWecomActions(set: ChannelsSet) {
  return {
    loadWecomConfig: async () => {
      set({ wecomIsLoading: true })
      try {
        const config = await invoke<WeComConfig | null>('get_wecom_config', getWorkspaceArgs())
        const status = await invoke<WeComGatewayStatusResponse>('get_wecom_gateway_status', getWorkspaceArgs())
        set({
          wecom: config || defaultWeComConfig,
          wecomGatewayStatus: status,
          wecomIsLoading: false,
        })
      } catch (e) {
        console.error('[WeCom] Failed to load config:', e)
        set({ wecomIsLoading: false })
      }
    },

    saveWecomConfig: async (config: WeComConfig) => {
      try {
        await invoke('save_wecom_config', { wecom: config, ...getWorkspaceArgs() })
        set({ wecom: config, wecomHasChanges: false })
      } catch (e) {
        console.error('[WeCom] Failed to save config:', e)
      }
    },

    startWecomGateway: async () => {
      try {
        await invoke('start_wecom_gateway', getWorkspaceArgs())
        const status = await invoke<WeComGatewayStatusResponse>('get_wecom_gateway_status', getWorkspaceArgs())
        set({ wecomGatewayStatus: status })
      } catch (e) {
        console.error('[WeCom] Failed to start gateway:', e)
        set({ wecomGatewayStatus: { status: 'error', errorMessage: String(e) } })
      }
    },

    stopWecomGateway: async () => {
      try {
        await invoke('stop_wecom_gateway', getWorkspaceArgs())
        set({ wecomGatewayStatus: { status: 'disconnected' } })
      } catch (e) {
        console.error('[WeCom] Failed to stop gateway:', e)
      }
    },

    refreshWecomStatus: async () => {
      try {
        const status = await invoke<WeComGatewayStatusResponse>('get_wecom_gateway_status', getWorkspaceArgs())
        set({ wecomGatewayStatus: status })
      } catch (e) {
        console.error('[WeCom] Failed to refresh status:', e)
      }
    },

    testWecomCredentials: async (botId: string, secret: string) => {
      set({ wecomIsTesting: true, wecomTestResult: null })
      try {
        const result = await invoke<string>('test_wecom_credentials', { botId, secret })
        set({ wecomIsTesting: false, wecomTestResult: { success: true, message: result } })
        return true
      } catch (e) {
        set({ wecomIsTesting: false, wecomTestResult: { success: false, message: String(e) } })
        return false
      }
    },

    clearWecomTestResult: () => set({ wecomTestResult: null }),

    startWecomQrAuth: async (): Promise<WeComQrAuthStart> => {
      return await invoke<WeComQrAuthStart>('start_wecom_qr_auth')
    },

    pollWecomQrAuth: async (scode: string): Promise<WeComQrAuthPollResult> => {
      return await invoke<WeComQrAuthPollResult>('poll_wecom_qr_auth', { scode })
    },

    setWecomHasChanges: (hasChanges: boolean) => set({ wecomHasChanges: hasChanges }),

    toggleWecomEnabled: async (enabled: boolean, config: WeComConfig) => {
        const updatedConfig = { ...config, enabled }
      try {
        await invoke('save_wecom_config', { wecom: updatedConfig, ...getWorkspaceArgs() })
        set({ wecom: updatedConfig })
        if (enabled) {
          set({ wecomIsLoading: true })
          try {
            await invoke('start_wecom_gateway', getWorkspaceArgs())
            await new Promise((resolve) => setTimeout(resolve, 1000))
            const status = await invoke<WeComGatewayStatusResponse>('get_wecom_gateway_status', getWorkspaceArgs())
            set({ wecomGatewayStatus: status, wecomIsLoading: false, wecomHasChanges: false })
          } catch (error) {
            console.error('[WeCom] Auto-start failed:', error)
            set({ wecomIsLoading: false })
          }
        } else {
          try {
            await invoke('stop_wecom_gateway', getWorkspaceArgs())
            set({ wecomGatewayStatus: { status: 'disconnected' }, wecomHasChanges: false })
          } catch {
            // Ignore stop errors
          }
        }
      } catch (error) {
        console.error('[WeCom] Toggle enabled failed:', error)
      }
    },
  }
}
