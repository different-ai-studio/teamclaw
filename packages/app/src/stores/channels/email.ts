import { invoke } from '@tauri-apps/api/core'
import type {
  EmailConfig,
  EmailGatewayStatusResponse,
  ChannelsState,
} from '../channels-types'
import { defaultEmailConfig } from '../channels-types'

type ChannelsSet = (fn: ((state: ChannelsState) => Partial<ChannelsState>) | Partial<ChannelsState>) => void

export function createEmailActions(set: ChannelsSet) {
  return {
    loadEmailConfig: async () => {
      set({ emailIsLoading: true, error: null })
      try {
        const config = await invoke<EmailConfig | null>('get_email_config')
        const status = await invoke<EmailGatewayStatusResponse>('get_email_gateway_status')
        set({
          email: config || defaultEmailConfig,
          emailGatewayStatus: status,
          emailIsLoading: false,
          emailHasChanges: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          emailIsLoading: false,
        })
      }
    },

    saveEmailConfig: async (config: EmailConfig) => {
      set({ emailIsLoading: true, error: null })
      try {
        await invoke('save_email_config', { email: config })
        set({
          email: config,
          emailIsLoading: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          emailIsLoading: false,
        })
        throw error
      }
    },

    startEmailGateway: async () => {
      set({ emailIsLoading: true, error: null })
      try {
        await invoke('start_email_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<EmailGatewayStatusResponse>('get_email_gateway_status')
        set({
          emailGatewayStatus: status,
          emailIsLoading: false,
          emailHasChanges: false,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        set({
          error: errorMessage,
          emailIsLoading: false,
          emailGatewayStatus: {
            status: 'error',
            errorMessage,
          },
        })
        throw error
      }
    },

    stopEmailGateway: async () => {
      set({ emailIsLoading: true, error: null })
      try {
        await invoke('stop_email_gateway')
        set({
          emailGatewayStatus: {
            status: 'disconnected',
          },
          emailIsLoading: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          emailIsLoading: false,
        })
        throw error
      }
    },

    refreshEmailStatus: async () => {
      try {
        const status = await invoke<EmailGatewayStatusResponse>('get_email_gateway_status')
        set({ emailGatewayStatus: status })
      } catch (error) {
        console.error('Failed to refresh Email gateway status:', error)
      }
    },

    testEmailConnection: async (config: EmailConfig) => {
      set({ emailIsTesting: true, emailTestResult: null })
      try {
        const result = await invoke<string>('test_email_connection', { email: config })
        set({
          emailIsTesting: false,
          emailTestResult: {
            success: true,
            message: result,
          },
        })
        return true
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        set({
          emailIsTesting: false,
          emailTestResult: {
            success: false,
            message: errorMessage,
          },
        })
        return false
      }
    },

    gmailAuthorize: async (clientId: string, clientSecret: string, email: string) => {
      set({ emailIsLoading: true, emailTestResult: null })
      try {
        await invoke<string>('gmail_authorize', { clientId, clientSecret, email })
        set({
          emailIsLoading: false,
          emailTestResult: {
            success: true,
            message: 'Gmail authorized successfully',
          },
        })
        return true
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        set({
          emailIsLoading: false,
          emailTestResult: {
            success: false,
            message: errorMessage,
          },
        })
        return false
      }
    },

    checkGmailAuth: async () => {
      try {
        return await invoke<boolean>('check_gmail_auth')
      } catch {
        return false
      }
    },

    clearEmailTestResult: () => set({ emailTestResult: null }),
    setEmailHasChanges: (hasChanges: boolean) => set({ emailHasChanges: hasChanges }),

    toggleEmailEnabled: async (enabled: boolean, config: EmailConfig) => {
      const updatedConfig = { ...config, enabled }
      try {
        await invoke('save_email_config', { email: updatedConfig })
        set({ email: updatedConfig })
        if (enabled) {
          set({ emailIsLoading: true })
          try {
            await invoke('start_email_gateway')
            await new Promise((resolve) => setTimeout(resolve, 1000))
            const status = await invoke<EmailGatewayStatusResponse>('get_email_gateway_status')
            set({ emailGatewayStatus: status, emailIsLoading: false, emailHasChanges: false })
          } catch (error) {
            console.error('[Email] Auto-start failed:', error)
            set({ emailIsLoading: false })
          }
        } else {
          try {
            await invoke('stop_email_gateway')
            set({ emailGatewayStatus: { status: 'disconnected' } })
          } catch {
            // May not be running
          }
        }
      } catch (error) {
        console.error('[Email] Toggle enabled failed:', error)
      }
    },
  }
}
