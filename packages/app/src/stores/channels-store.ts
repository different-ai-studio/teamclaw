import { create } from 'zustand'
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
import {
  listChannels,
  AmuxdUnreachableError,
  type ChannelStatus as AmuxdChannelStatus,
} from '@/lib/amuxd-channels'

function describe(e: unknown): string {
  if (e instanceof AmuxdUnreachableError) return 'amuxd not running. Start amuxd and try again.'
  return e instanceof Error ? e.message : String(e)
}

function discordStatus(list: AmuxdChannelStatus[]): GatewayStatusResponse {
  const entry = list.find((c) => c.platform === 'discord')
  if (!entry) return { status: 'disconnected', discordConnected: false, connectedGuilds: [] }
  if (entry.lastError) {
    return { status: 'error', discordConnected: false, errorMessage: entry.lastError, connectedGuilds: [] }
  }
  if (entry.connected) return { status: 'connected', discordConnected: true, connectedGuilds: [] }
  if (entry.enabled) return { status: 'connecting', discordConnected: false, connectedGuilds: [] }
  return { status: 'disconnected', discordConnected: false, connectedGuilds: [] }
}

function feishuStatus(list: AmuxdChannelStatus[]): FeishuGatewayStatusResponse {
  const entry = list.find((c) => c.platform === 'feishu')
  if (!entry) return { status: 'disconnected' }
  if (entry.lastError) return { status: 'error', errorMessage: entry.lastError }
  if (entry.connected) return { status: 'connected' }
  if (entry.enabled) return { status: 'connecting' }
  return { status: 'disconnected' }
}

function emailStatus(list: AmuxdChannelStatus[]): EmailGatewayStatusResponse {
  const entry = list.find((c) => c.platform === 'email')
  if (!entry) return { status: 'disconnected' }
  if (entry.lastError) return { status: 'error', errorMessage: entry.lastError }
  if (entry.connected) return { status: 'connected' }
  if (entry.enabled) return { status: 'connecting' }
  return { status: 'disconnected' }
}

function kookStatus(list: AmuxdChannelStatus[]): KookGatewayStatusResponse {
  const entry = list.find((c) => c.platform === 'kook')
  if (!entry) return { status: 'disconnected', connectedGuilds: [] }
  if (entry.lastError) return { status: 'error', errorMessage: entry.lastError, connectedGuilds: [] }
  if (entry.connected) return { status: 'connected', connectedGuilds: [] }
  if (entry.enabled) return { status: 'connecting', connectedGuilds: [] }
  return { status: 'disconnected', connectedGuilds: [] }
}

function wecomStatus(list: AmuxdChannelStatus[]): WeComGatewayStatusResponse {
  const entry = list.find((c) => c.platform === 'wecom')
  if (!entry) return { status: 'disconnected' }
  if (entry.lastError) return { status: 'error', errorMessage: entry.lastError }
  if (entry.connected) return { status: 'connected' }
  if (entry.enabled) return { status: 'connecting' }
  return { status: 'disconnected' }
}

function wechatStatus(list: AmuxdChannelStatus[]): WeChatGatewayStatusResponse {
  const entry = list.find((c) => c.platform === 'wechat')
  if (!entry) return { status: 'disconnected' }
  if (entry.lastError) return { status: 'error', errorMessage: entry.lastError }
  if (entry.connected) return { status: 'connected' }
  if (entry.enabled) return { status: 'connecting' }
  return { status: 'disconnected' }
}

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
  gmailAuthUrl: null,

  // Compose all channel actions
  ...createDiscordActions(set),
  ...createFeishuActions(set),
  ...createEmailActions(set),
  ...createKookActions(set),
  ...createWecomActions(set),
  ...createWechatActions(set),

  // ========== Shared gateway logic ==========

  // The discord createDiscordActions exposes `loadConfig` for its own slot;
  // we override it here to fan out across every platform from a single
  // `listChannels()` call to amuxd.
  loadConfig: async () => {
    set({ isLoading: true, error: null })
    try {
      const list = await listChannels()
      // amuxd does not expose persisted config payloads, only status. Seed
      // the per-platform config slots with defaults so the UI can still
      // render forms; users overwrite them with `save*Config`.
      set({
        discord: defaultDiscordConfig,
        gatewayStatus: discordStatus(list),
        feishu: defaultFeishuConfig,
        feishuGatewayStatus: feishuStatus(list),
        email: defaultEmailConfig,
        emailGatewayStatus: emailStatus(list),
        kook: defaultKookConfig,
        kookGatewayStatus: kookStatus(list),
        wecom: defaultWeComConfig,
        wecomGatewayStatus: wecomStatus(list),
        wechat: defaultWeChatConfig,
        wechatGatewayStatus: wechatStatus(list),
        isLoading: false,
        hasChanges: false,
        feishuHasChanges: false,
        emailHasChanges: false,
        wecomHasChanges: false,
        wechatHasChanges: false,
      })
    } catch (error) {
      set({
        error: describe(error),
        isLoading: false,
      })
    }
  },

  // ========== Stop All and Reset (for workspace switching) ==========
  //
  // amuxd owns the gateway lifecycle now — the desktop app no longer toggles
  // them on workspace switch. We just reset local UI state.

  stopAllAndReset: async () => {
    console.log('[Channels] Resetting local UI state for workspace switch...')
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
  },

  // ========== Auto-Start Enabled Gateways ==========
  //
  // amuxd auto-starts whatever is enabled in `daemon.toml`. The desktop app's
  // job here reduces to "ask amuxd for current status and reflect it in the
  // UI".
  autoStartEnabledGateways: async () => {
    try {
      const list = await listChannels()
      set({
        gatewayStatus: discordStatus(list),
        feishuGatewayStatus: feishuStatus(list),
        emailGatewayStatus: emailStatus(list),
        kookGatewayStatus: kookStatus(list),
        wecomGatewayStatus: wecomStatus(list),
        wechatGatewayStatus: wechatStatus(list),
      })
    } catch (error) {
      console.error('[AutoStart] Failed to fetch channel statuses from amuxd:', error)
      set({ error: describe(error) })
    }
  },

  // ========== Keep-Alive: Periodic Health Check ==========
  //
  // amuxd's channel manager runs its own keep-alive loop. From the UI side
  // we just re-poll status periodically and surface it.
  keepAliveCheck: async () => {
    try {
      const list = await listChannels()
      set({
        gatewayStatus: discordStatus(list),
        feishuGatewayStatus: feishuStatus(list),
        emailGatewayStatus: emailStatus(list),
        kookGatewayStatus: kookStatus(list),
        wecomGatewayStatus: wecomStatus(list),
        wechatGatewayStatus: wechatStatus(list),
      })
    } catch {
      // Ignore — keep-alive failures shouldn't surface UI errors on every tick.
    }
  },
}))
