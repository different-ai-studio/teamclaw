import { invoke } from '@tauri-apps/api/core'
import type {
  WeChatConfig,
  WeChatGatewayStatusResponse,
  ChannelsState,
} from '../channels-types'
import { defaultWeChatConfig } from '../channels-types'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

export function createWechatActions(set: ChannelsSet) {
  return {
    loadWechatConfig: async () => {
      set({ wechatIsLoading: true })
      try {
        const config = await invoke<WeChatConfig | null>('get_wechat_config')
        const status = await invoke<WeChatGatewayStatusResponse>('get_wechat_gateway_status')
        set({
          wechat: config || defaultWeChatConfig,
          wechatGatewayStatus: status,
          wechatIsLoading: false,
        })
      } catch (e) {
        console.error('[WeChat] Failed to load config:', e)
        set({ wechatIsLoading: false })
      }
    },

    saveWechatConfig: async (config: WeChatConfig) => {
      try {
        await invoke('save_wechat_config', { wechat: config })
        set({ wechat: config, wechatHasChanges: false })
      } catch (e) {
        console.error('[WeChat] Failed to save config:', e)
      }
    },

    startWechatGateway: async () => {
      try {
        await invoke('start_wechat_gateway')
        const status = await invoke<WeChatGatewayStatusResponse>('get_wechat_gateway_status')
        set({ wechatGatewayStatus: status })
      } catch (e) {
        console.error('[WeChat] Failed to start gateway:', e)
        set({ wechatGatewayStatus: { status: 'error', errorMessage: String(e) } })
      }
    },

    stopWechatGateway: async () => {
      try {
        await invoke('stop_wechat_gateway')
        set({ wechatGatewayStatus: { status: 'disconnected' } })
      } catch (e) {
        console.error('[WeChat] Failed to stop gateway:', e)
      }
    },

    refreshWechatStatus: async () => {
      try {
        const status = await invoke<WeChatGatewayStatusResponse>('get_wechat_gateway_status')
        set({ wechatGatewayStatus: status })
      } catch (e) {
        console.error('[WeChat] Failed to refresh status:', e)
      }
    },

    testWechatConnection: async (botToken: string) => {
      set({ wechatIsTesting: true, wechatTestResult: null })
      try {
        const result = await invoke<string>('test_wechat_connection', { botToken })
        set({ wechatIsTesting: false, wechatTestResult: { success: true, message: result } })
        return true
      } catch (e) {
        set({ wechatIsTesting: false, wechatTestResult: { success: false, message: String(e) } })
        return false
      }
    },

    clearWechatTestResult: () => set({ wechatTestResult: null }),

    setWechatHasChanges: (hasChanges: boolean) => set({ wechatHasChanges: hasChanges }),

    toggleWechatEnabled: async (enabled: boolean, config: WeChatConfig) => {
      const updatedConfig = { ...config, enabled }
      try {
        await invoke('save_wechat_config', { wechat: updatedConfig })
        set({ wechat: updatedConfig })
        if (enabled) {
          set({ wechatIsLoading: true })
          try {
            await invoke('start_wechat_gateway')
            await new Promise((resolve) => setTimeout(resolve, 1000))
            const status = await invoke<WeChatGatewayStatusResponse>('get_wechat_gateway_status')
            set({ wechatGatewayStatus: status, wechatIsLoading: false, wechatHasChanges: false })
          } catch (error) {
            console.error('[WeChat] Auto-start failed:', error)
            set({ wechatIsLoading: false })
          }
        } else {
          try {
            await invoke('stop_wechat_gateway')
            set({ wechatGatewayStatus: { status: 'disconnected' }, wechatHasChanges: false })
          } catch {
            // Ignore stop errors
          }
        }
      } catch (error) {
        console.error('[WeChat] Toggle enabled failed:', error)
      }
    },
  }
}
