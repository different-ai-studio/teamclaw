import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import type {
  DiscordConfig,
  FeishuConfig,
  EmailConfig,
  KookConfig,
  WeComConfig,
  WeChatConfig,
  GatewayStatusResponse,
  FeishuGatewayStatusResponse,
  EmailGatewayStatusResponse,
  KookGatewayStatusResponse,
  WeComGatewayStatusResponse,
  WeChatGatewayStatusResponse,
  ChannelsState,
} from './channels-types'
import {
  defaultDiscordConfig,
  defaultFeishuConfig,
  defaultKookConfig,
  defaultEmailConfig,
  defaultWeComConfig,
  defaultWeChatConfig,
} from './channels-types'
import { createDiscordActions } from './channels/discord'
import { createFeishuActions } from './channels/feishu'
import { createEmailActions } from './channels/email'
import { createKookActions } from './channels/kook'
import { createWecomActions } from './channels/wecom'
import { createWechatActions } from './channels/wechat'

export const useChannelsStore = create<ChannelsState>((set) => ({
  // Discord initial state
  discord: null,
  isLoading: false,
  error: null,
  gatewayStatus: {
    status: 'disconnected',
    discordConnected: false,
    connectedGuilds: [],
  },
  hasChanges: false,
  isTesting: false,
  testResult: null,

  // Feishu initial state
  feishu: null,
  feishuIsLoading: false,
  feishuGatewayStatus: {
    status: 'disconnected',
  },
  feishuHasChanges: false,
  feishuIsTesting: false,
  feishuTestResult: null,

  // KOOK initial state
  kook: defaultKookConfig,
  kookIsLoading: false,
  kookGatewayStatus: {
    status: 'disconnected',
    connectedGuilds: [],
  },
  kookHasChanges: false,
  kookIsTesting: false,
  kookTestResult: null,

  // WeCom initial state
  wecom: null,
  wecomIsLoading: false,
  wecomGatewayStatus: { status: 'disconnected' },
  wecomHasChanges: false,
  wecomIsTesting: false,
  wecomTestResult: null,

  // WeChat initial state
  wechat: null,
  wechatIsLoading: false,
  wechatGatewayStatus: { status: 'disconnected' },
  wechatHasChanges: false,
  wechatIsTesting: false,
  wechatTestResult: null,

  // Email initial state
  email: null,
  emailIsLoading: false,
  emailGatewayStatus: {
    status: 'disconnected',
  },
  emailHasChanges: false,
  emailIsTesting: false,
  emailTestResult: null,

  // Compose all channel actions
  ...createDiscordActions(set),
  ...createFeishuActions(set),
  ...createEmailActions(set),
  ...createKookActions(set),
  ...createWecomActions(set),
  ...createWechatActions(set),

  // ========== Shared gateway logic ==========

  // The loadConfig in discord.ts only loads Discord. Override it here to load ALL configs.
  loadConfig: async () => {
    set({ isLoading: true, error: null })
    try {
      const config = await invoke<DiscordConfig | null>('get_discord_config')
      const status = await invoke<GatewayStatusResponse>('get_gateway_status')
      // Also load Feishu config
      let feishuConfig: FeishuConfig | null = null
      let feishuStatus: FeishuGatewayStatusResponse = { status: 'disconnected' }
      try {
        feishuConfig = await invoke<FeishuConfig | null>('get_feishu_config')
        feishuStatus = await invoke<FeishuGatewayStatusResponse>('get_feishu_gateway_status')
      } catch {
        // Feishu config may not exist yet
      }
      // Also load Email config
      let emailConfig: EmailConfig | null = null
      let emailStatus: EmailGatewayStatusResponse = { status: 'disconnected' }
      try {
        emailConfig = await invoke<EmailConfig | null>('get_email_config')
        emailStatus = await invoke<EmailGatewayStatusResponse>('get_email_gateway_status')
      } catch {
        // Email config may not exist yet
      }
      // Also load KOOK config
      let kookConfig: KookConfig | null = null
      let kookStatus: KookGatewayStatusResponse = { status: 'disconnected', errorMessage: undefined, botUsername: undefined, connectedGuilds: [] }
      try {
        kookConfig = await invoke<KookConfig | null>('get_kook_config')
        kookStatus = await invoke<KookGatewayStatusResponse>('get_kook_gateway_status')
      } catch {
        // KOOK config may not exist yet
      }
      // Also load WeCom config
      let wecomConfig: WeComConfig | null = null
      let wecomStatus: WeComGatewayStatusResponse = { status: 'disconnected' }
      try {
        wecomConfig = await invoke<WeComConfig | null>('get_wecom_config')
        wecomStatus = await invoke<WeComGatewayStatusResponse>('get_wecom_gateway_status')
      } catch {
        // WeCom config may not exist yet
      }
      // Also load WeChat config
      let wechatConfig: WeChatConfig | null = null
      let wechatStatus: WeChatGatewayStatusResponse = { status: 'disconnected' }
      try {
        wechatConfig = await invoke<WeChatConfig | null>('get_wechat_config')
        wechatStatus = await invoke<WeChatGatewayStatusResponse>('get_wechat_gateway_status')
      } catch {
        // WeChat config may not exist yet
      }
      set({
        discord: config || defaultDiscordConfig,
        gatewayStatus: status,
        feishu: feishuConfig || defaultFeishuConfig,
        feishuGatewayStatus: feishuStatus,
        email: emailConfig || defaultEmailConfig,
        emailGatewayStatus: emailStatus,
        kook: kookConfig || defaultKookConfig,
        kookGatewayStatus: kookStatus,
        wecom: wecomConfig || defaultWeComConfig,
        wecomGatewayStatus: wecomStatus,
        wechat: wechatConfig || defaultWeChatConfig,
        wechatGatewayStatus: wechatStatus,
        isLoading: false,
        hasChanges: false,
        feishuHasChanges: false,
        emailHasChanges: false,
        wecomHasChanges: false,
        wechatHasChanges: false,
      })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        isLoading: false,
      })
    }
  },

  // ========== Stop All and Reset (for workspace switching) ==========

  stopAllAndReset: async () => {
    console.log('[Channels] Stopping all gateways and resetting state...')
    const state = useChannelsStore.getState()

    if (state.gatewayStatus.status !== 'disconnected') {
      try {
        await invoke('stop_gateway')
      } catch (e) {
        console.warn('[Channels] Failed to stop Discord gateway:', e)
      }
    }

    if (state.feishuGatewayStatus.status !== 'disconnected') {
      try {
        await invoke('stop_feishu_gateway')
      } catch (e) {
        console.warn('[Channels] Failed to stop Feishu gateway:', e)
      }
    }

    if (state.emailGatewayStatus.status !== 'disconnected') {
      try {
        await invoke('stop_email_gateway')
      } catch (e) {
        console.warn('[Channels] Failed to stop Email gateway:', e)
      }
    }

    if (state.kookGatewayStatus.status !== 'disconnected') {
      try {
        await invoke('stop_kook_gateway')
      } catch (e) {
        console.warn('[Channels] Failed to stop KOOK gateway:', e)
      }
    }

    if (state.wecomGatewayStatus.status !== 'disconnected') {
      try {
        await invoke('stop_wecom_gateway')
      } catch (e) {
        console.warn('[Channels] Failed to stop WeCom gateway:', e)
      }
    }

    if (state.wechatGatewayStatus.status !== 'disconnected') {
      try {
        await invoke('stop_wechat_gateway')
      } catch (e) {
        console.warn('[Channels] Failed to stop WeChat gateway:', e)
      }
    }

    set({
      discord: null,
      isLoading: false,
      error: null,
      gatewayStatus: {
        status: 'disconnected',
        discordConnected: false,
        connectedGuilds: [],
      },
      hasChanges: false,
      isTesting: false,
      testResult: null,
      feishu: null,
      feishuIsLoading: false,
      feishuGatewayStatus: { status: 'disconnected' },
      feishuHasChanges: false,
      kook: null,
      kookIsLoading: false,
      kookGatewayStatus: { status: 'disconnected', connectedGuilds: [] },
      kookHasChanges: false,
      feishuIsTesting: false,
      feishuTestResult: null,
      email: null,
      emailIsLoading: false,
      emailGatewayStatus: { status: 'disconnected' },
      emailHasChanges: false,
      emailIsTesting: false,
      emailTestResult: null,
      wecom: null,
      wecomIsLoading: false,
      wecomGatewayStatus: { status: 'disconnected' },
      wecomHasChanges: false,
      wecomIsTesting: false,
      wecomTestResult: null,
      wechat: null,
      wechatIsLoading: false,
      wechatGatewayStatus: { status: 'disconnected' },
      wechatHasChanges: false,
      wechatIsTesting: false,
      wechatTestResult: null,
    })
    console.log('[Channels] All gateways stopped and state reset')
  },

  // ========== Auto-Start Enabled Gateways ==========

  autoStartEnabledGateways: async () => {
    const state = useChannelsStore.getState()

    if (state.discord?.enabled && state.gatewayStatus.status === 'disconnected') {
      console.log('[AutoStart] Starting Discord gateway...')
      try {
        await invoke('start_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<GatewayStatusResponse>('get_gateway_status')
        set({ gatewayStatus: status })
      } catch (error) {
        console.error('[AutoStart] Discord start failed:', error)
      }
    }

    if (state.feishu?.enabled && state.feishuGatewayStatus.status === 'disconnected') {
      console.log('[AutoStart] Starting Feishu gateway...')
      try {
        await invoke('start_feishu_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<FeishuGatewayStatusResponse>('get_feishu_gateway_status')
        set({ feishuGatewayStatus: status })
      } catch (error) {
        console.error('[AutoStart] Feishu start failed:', error)
      }
    }

    if (state.kook?.enabled && state.kookGatewayStatus.status === 'disconnected') {
      console.log('[AutoStart] Starting KOOK gateway...')
      try {
        await invoke('start_kook_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<KookGatewayStatusResponse>('get_kook_gateway_status')
        set({ kookGatewayStatus: status })
      } catch (error) {
        console.error('[AutoStart] KOOK start failed:', error)
      }
    }

    if (state.wecom?.enabled && state.wecomGatewayStatus.status === 'disconnected') {
      console.log('[AutoStart] Starting WeCom gateway...')
      try {
        await invoke('start_wecom_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<WeComGatewayStatusResponse>('get_wecom_gateway_status')
        set({ wecomGatewayStatus: status })
      } catch (error) {
        console.error('[AutoStart] WeCom start failed:', error)
      }
    }

    if (state.wechat?.enabled && state.wechatGatewayStatus.status === 'disconnected') {
      console.log('[AutoStart] Starting WeChat gateway...')
      try {
        await invoke('start_wechat_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<WeChatGatewayStatusResponse>('get_wechat_gateway_status')
        set({ wechatGatewayStatus: status })
      } catch (error) {
        console.error('[AutoStart] WeChat start failed:', error)
      }
    }

    // Email last — Gmail OAuth may block waiting for browser authorization
    if (state.email?.enabled && state.emailGatewayStatus.status === 'disconnected') {
      console.log('[AutoStart] Starting Email gateway...')
      try {
        await invoke('start_email_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<EmailGatewayStatusResponse>('get_email_gateway_status')
        set({ emailGatewayStatus: status })
      } catch (error) {
        console.error('[AutoStart] Email start failed:', error)
      }
    }

  },

  // ========== Keep-Alive: Periodic Health Check ==========

  keepAliveCheck: async () => {
    try {
      const [discordStatus, feishuStatus, emailStatus, kookStatus, wecomStatus, wechatStatus] = await Promise.all([
        invoke<GatewayStatusResponse>('get_gateway_status').catch(() => null),
        invoke<FeishuGatewayStatusResponse>('get_feishu_gateway_status').catch(() => null),
        invoke<EmailGatewayStatusResponse>('get_email_gateway_status').catch(() => null),
        invoke<KookGatewayStatusResponse>('get_kook_gateway_status').catch(() => null),
        invoke<WeComGatewayStatusResponse>('get_wecom_gateway_status').catch(() => null),
        invoke<WeChatGatewayStatusResponse>('get_wechat_gateway_status').catch(() => null),
      ])
      if (discordStatus) set({ gatewayStatus: discordStatus })
      if (feishuStatus) set({ feishuGatewayStatus: feishuStatus })
      if (emailStatus) set({ emailGatewayStatus: emailStatus })
      if (kookStatus) set({ kookGatewayStatus: kookStatus })
      if (wecomStatus) set({ wecomGatewayStatus: wecomStatus })
      if (wechatStatus) set({ wechatGatewayStatus: wechatStatus })
    } catch {
      // Ignore status refresh errors
    }

    const updated = useChannelsStore.getState()

    // Discord: restart if enabled but disconnected/errored
    if (
      updated.discord?.enabled &&
      (updated.gatewayStatus.status === 'disconnected' || updated.gatewayStatus.status === 'error')
    ) {
      console.log('[KeepAlive] Discord is enabled but status=', updated.gatewayStatus.status, '- restarting...')
      try {
        await invoke('stop_gateway').catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 500))
        await invoke('start_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<GatewayStatusResponse>('get_gateway_status')
        set({ gatewayStatus: status })
        console.log('[KeepAlive] Discord restarted, status=', status.status)
      } catch (error) {
        console.error('[KeepAlive] Discord restart failed:', error)
      }
    }

    // Feishu: restart if enabled but disconnected/errored
    if (
      updated.feishu?.enabled &&
      (updated.feishuGatewayStatus.status === 'disconnected' || updated.feishuGatewayStatus.status === 'error')
    ) {
      console.log('[KeepAlive] Feishu is enabled but status=', updated.feishuGatewayStatus.status, '- restarting...')
      try {
        await invoke('stop_feishu_gateway').catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 500))
        await invoke('start_feishu_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<FeishuGatewayStatusResponse>('get_feishu_gateway_status')
        set({ feishuGatewayStatus: status })
        console.log('[KeepAlive] Feishu restarted, status=', status.status)
      } catch (error) {
        console.error('[KeepAlive] Feishu restart failed:', error)
      }
    }

    // Email: restart if enabled but disconnected/errored
    if (
      updated.email?.enabled &&
      (updated.emailGatewayStatus.status === 'disconnected' || updated.emailGatewayStatus.status === 'error')
    ) {
      console.log('[KeepAlive] Email is enabled but status=', updated.emailGatewayStatus.status, '- restarting...')
      try {
        await invoke('stop_email_gateway').catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 500))
        await invoke('start_email_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<EmailGatewayStatusResponse>('get_email_gateway_status')
        set({ emailGatewayStatus: status })
        console.log('[KeepAlive] Email restarted, status=', status.status)
      } catch (error) {
        console.error('[KeepAlive] Email restart failed:', error)
      }
    }

    // KOOK: restart if enabled but disconnected/errored
    if (
      updated.kook?.enabled &&
      (updated.kookGatewayStatus.status === 'disconnected' || updated.kookGatewayStatus.status === 'error')
    ) {
      console.log('[KeepAlive] KOOK is enabled but status=', updated.kookGatewayStatus.status, '- restarting...')
      try {
        await invoke('stop_kook_gateway').catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 500))
        await invoke('start_kook_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<KookGatewayStatusResponse>('get_kook_gateway_status')
        set({ kookGatewayStatus: status })
        console.log('[KeepAlive] KOOK restarted, status=', status.status)
      } catch (error) {
        console.error('[KeepAlive] KOOK restart failed:', error)
      }
    }

    // WeCom: restart if enabled but disconnected/errored
    if (
      updated.wecom?.enabled &&
      (updated.wecomGatewayStatus.status === 'disconnected' || updated.wecomGatewayStatus.status === 'error')
    ) {
      console.log('[KeepAlive] WeCom is enabled but status=', updated.wecomGatewayStatus.status, '- restarting...')
      try {
        await invoke('stop_wecom_gateway').catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 500))
        await invoke('start_wecom_gateway')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await invoke<WeComGatewayStatusResponse>('get_wecom_gateway_status')
        set({ wecomGatewayStatus: status })
        console.log('[KeepAlive] WeCom restarted, status=', status.status)
      } catch (error) {
        console.error('[KeepAlive] WeCom restart failed:', error)
      }
    }

    // WeChat: restart if enabled but disconnected/errored (skip auth errors)
    if (
      updated.wechat?.enabled &&
      (updated.wechatGatewayStatus.status === 'disconnected' || updated.wechatGatewayStatus.status === 'error')
    ) {
      const errMsg = updated.wechatGatewayStatus.errorMessage || ''
      if (errMsg.includes('re-authenticate') || errMsg.includes('expired')) {
        console.log('[KeepAlive] WeChat has auth error, skipping restart:', errMsg)
      } else {
        console.log('[KeepAlive] WeChat is enabled but status=', updated.wechatGatewayStatus.status, '- restarting...')
        try {
          await invoke('stop_wechat_gateway').catch(() => {})
          await new Promise((resolve) => setTimeout(resolve, 500))
          await invoke('start_wechat_gateway')
          await new Promise((resolve) => setTimeout(resolve, 1000))
          const status = await invoke<WeChatGatewayStatusResponse>('get_wechat_gateway_status')
          set({ wechatGatewayStatus: status })
          console.log('[KeepAlive] WeChat restarted, status=', status.status)
        } catch (error) {
          console.error('[KeepAlive] WeChat restart failed:', error)
        }
      }
    }
  },
}))
