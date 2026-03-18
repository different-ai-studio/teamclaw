import { invoke } from '@tauri-apps/api/core'
import type {
  DiscordConfig,
  GatewayStatusResponse,
  ChannelsState,
} from '../channels-types'
import { defaultDiscordConfig } from '../channels-types'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

export function createDiscordActions(set: ChannelsSet) {
  return {
    loadConfig: async () => {
      set({ isLoading: true, error: null })
      try {
        const config = await invoke<DiscordConfig | null>('get_discord_config')
        const status = await invoke<GatewayStatusResponse>('get_gateway_status')
        set({
          discord: config || defaultDiscordConfig,
          gatewayStatus: status,
          isLoading: false,
          hasChanges: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          isLoading: false,
        })
      }
    },

    saveDiscordConfig: async (config: DiscordConfig) => {
      set({ isLoading: true, error: null })
      try {
        await invoke('save_discord_config', { discord: config })
        set({
          discord: config,
          isLoading: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          isLoading: false,
        })
        throw error
      }
    },

    startGateway: async () => {
      set({ isLoading: true, error: null })
      try {
        await invoke('start_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<GatewayStatusResponse>('get_gateway_status')
        set({
          gatewayStatus: status,
          isLoading: false,
          hasChanges: false,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        set({
          error: errorMessage,
          isLoading: false,
          gatewayStatus: {
            status: 'error',
            discordConnected: false,
            errorMessage,
            connectedGuilds: [],
          },
        })
        throw error
      }
    },

    stopGateway: async () => {
      set({ isLoading: true, error: null })
      try {
        await invoke('stop_gateway')
        set({
          gatewayStatus: {
            status: 'disconnected',
            discordConnected: false,
            connectedGuilds: [],
          },
          isLoading: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          isLoading: false,
        })
        throw error
      }
    },

    refreshStatus: async () => {
      try {
        const status = await invoke<GatewayStatusResponse>('get_gateway_status')
        set({ gatewayStatus: status })
      } catch (error) {
        console.error('Failed to refresh gateway status:', error)
      }
    },

    testToken: async (token: string) => {
      set({ isTesting: true, testResult: null })
      try {
        const username = await invoke<string>('test_discord_token', { token })
        set({
          isTesting: false,
          testResult: {
            success: true,
            message: `Connected as ${username}`,
          },
        })
        return true
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        set({
          isTesting: false,
          testResult: {
            success: false,
            message: errorMessage,
          },
        })
        return false
      }
    },

    clearError: () => set({ error: null }),
    clearTestResult: () => set({ testResult: null }),
    setHasChanges: (hasChanges: boolean) => set({ hasChanges }),

    toggleDiscordEnabled: async (enabled: boolean, config: DiscordConfig) => {
      const updatedConfig = { ...config, enabled }
      try {
        await invoke('save_discord_config', { discord: updatedConfig })
        set({ discord: updatedConfig })
        if (enabled) {
          set({ isLoading: true })
          try {
            await invoke('start_gateway')
            await new Promise((resolve) => setTimeout(resolve, 1000))
            const status = await invoke<GatewayStatusResponse>('get_gateway_status')
            set({ gatewayStatus: status, isLoading: false, hasChanges: false })
          } catch (error) {
            console.error('[Discord] Auto-start failed:', error)
            set({ isLoading: false })
          }
        } else {
          try {
            await invoke('stop_gateway')
            set({
              gatewayStatus: {
                status: 'disconnected',
                discordConnected: false,
                connectedGuilds: [],
              },
            })
          } catch {
            // May not be running
          }
        }
      } catch (error) {
        console.error('[Discord] Toggle enabled failed:', error)
      }
    },
  }
}
