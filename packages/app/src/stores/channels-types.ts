// Channel type definitions and default configs — extracted from channels.ts
import { buildConfig } from '@/lib/build-config'

// Gateway status types
export type GatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// DM configuration
export interface DmConfig {
  enabled: boolean
  policy: 'open' | 'allowlist'
  allowFrom: string[]
  groupEnabled: boolean
  groupChannels: string[]
}

// Channel rule
export interface ChannelRule {
  allow: boolean
  requireMention?: boolean
  users: string[]
}

// Guild configuration
export interface GuildConfig {
  slug?: string
  channels: Record<string, ChannelRule>
}

// Retry configuration
export interface RetryConfig {
  attempts: number
  minDelayMs: number
  maxDelayMs: number
  jitter: number
}

// Discord configuration
export interface DiscordConfig {
  enabled: boolean
  token: string
  dm: DmConfig
  guilds: Record<string, GuildConfig>
  retry?: RetryConfig
}

// Feishu chat configuration
export interface FeishuChatConfig {
  allow: boolean
  users: string[]
}

// Feishu configuration
export interface FeishuConfig {
  enabled: boolean
  appId: string
  appSecret: string
  chats: Record<string, FeishuChatConfig>
}

// Feishu gateway status
export type FeishuGatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// Feishu gateway status response
export interface FeishuGatewayStatusResponse {
  status: FeishuGatewayStatus
  errorMessage?: string
  appId?: string
}

// Email provider type
export type EmailProvider = 'gmail' | 'custom'

// Email configuration
export interface EmailConfig {
  enabled: boolean
  provider: EmailProvider
  // Gmail OAuth2 fields
  gmailClientId: string
  gmailClientSecret: string
  gmailEmail: string
  gmailAuthorized: boolean
  // Custom IMAP/SMTP fields
  imapServer: string
  imapPort: number
  smtpServer: string
  smtpPort: number
  username: string
  password: string
  // Filter settings
  recipientAlias: string
  allowedSenders: string[]
  labels: string[]
  replyAllNew: boolean
  displayName: string
}

// Email gateway status
export type EmailGatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// Email gateway status response
export interface EmailGatewayStatusResponse {
  status: EmailGatewayStatus
  errorMessage?: string
  email?: string
}

// KOOK configuration
// KOOK-specific DM configuration
export interface KookDmConfig {
  enabled: boolean
  policy: 'open' | 'allowlist'
  allowFrom: string[]
}

// KOOK-specific channel rule
export interface KookChannelRule {
  enabled: boolean
  requireMention: boolean
  allowedUsers: string[]
}

// KOOK-specific guild configuration
export interface KookGuildConfig {
  enabled: boolean
  slug?: string
  channels: Record<string, KookChannelRule>
}

export interface KookConfig {
  enabled: boolean
  token: string
  dm: KookDmConfig
  guilds: Record<string, KookGuildConfig>
}

// KOOK gateway status
export type KookGatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// KOOK gateway status response
export interface KookGatewayStatusResponse {
  status: KookGatewayStatus
  errorMessage?: string
  botUsername?: string
  connectedGuilds: string[]
}

// WeCom types
export interface WeComConfig {
  enabled: boolean
  botId: string
  secret: string
  encodingAesKey?: string
  /** Auto-recorded userid of the person who bound this bot (first DM sender) */
  ownerId?: string
}

export type WeComGatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface WeComGatewayStatusResponse {
  status: WeComGatewayStatus
  errorMessage?: string
  botId?: string
}

export interface WeComQrAuthStart {
  scode: string
  auth_url: string
}

export interface WeComQrAuthPollResult {
  status: 'waiting' | 'success' | 'expired'
  botId?: string
  secret?: string
}

// WeChat types
export interface WeChatConfig {
  enabled: boolean
  botToken: string
  accountId: string
  baseUrl: string
  syncBuf?: string
}

export type WeChatGatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface WeChatGatewayStatusResponse {
  status: WeChatGatewayStatus
  errorMessage?: string
  accountId?: string
}

// Channels configuration
export interface ChannelsConfig {
  discord?: DiscordConfig
  feishu?: FeishuConfig
  email?: EmailConfig
  kook?: KookConfig
  wecom?: WeComConfig
  wechat?: WeChatConfig
}

// Gateway status response
export interface GatewayStatusResponse {
  status: GatewayStatus
  discordConnected: boolean
  errorMessage?: string
  connectedGuilds: string[]
  botUsername?: string
}

// Default configurations
export const defaultWeComConfig: WeComConfig = {
  enabled: false,
  botId: '',
  secret: '',
  encodingAesKey: undefined,
}

export const defaultWeChatConfig: WeChatConfig = {
  enabled: false,
  botToken: '',
  accountId: '',
  baseUrl: 'https://ilinkai.weixin.qq.com',
}

export const defaultDmConfig: DmConfig = {
  enabled: true,
  policy: 'allowlist',
  allowFrom: [],
  groupEnabled: false,
  groupChannels: [],
}

export const defaultDiscordConfig: DiscordConfig = {
  enabled: false,
  token: '',
  dm: defaultDmConfig,
  guilds: {},
}

export const defaultFeishuConfig: FeishuConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  chats: {},
}

export const defaultKookDmConfig: KookDmConfig = {
  enabled: false,
  policy: 'open',
  allowFrom: [],
}

export const defaultKookConfig: KookConfig = {
  enabled: false,
  token: '',
  dm: defaultKookDmConfig,
  guilds: {},
}

export const defaultEmailConfig: EmailConfig = {
  enabled: false,
  provider: 'gmail',
  gmailClientId: '',
  gmailClientSecret: '',
  gmailEmail: '',
  gmailAuthorized: false,
  imapServer: '',
  imapPort: 993,
  smtpServer: '',
  smtpPort: 465,
  username: '',
  password: '',
  recipientAlias: '',
  allowedSenders: [],
  labels: [],
  replyAllNew: false,
  displayName: `${buildConfig.app.name} Agent`,
}

// Channels store state interface
export interface ChannelsState {
  discord: DiscordConfig | null
  isLoading: boolean
  error: string | null
  gatewayStatus: GatewayStatusResponse
  hasChanges: boolean
  isTesting: boolean
  testResult: { success: boolean; message: string } | null

  // Feishu state
  feishu: FeishuConfig | null
  feishuIsLoading: boolean
  feishuGatewayStatus: FeishuGatewayStatusResponse
  feishuHasChanges: boolean
  feishuIsTesting: boolean
  feishuTestResult: { success: boolean; message: string } | null

  // Email state
  email: EmailConfig | null
  emailIsLoading: boolean
  emailGatewayStatus: EmailGatewayStatusResponse
  emailHasChanges: boolean
  emailIsTesting: boolean
  emailTestResult: { success: boolean; message: string } | null

  // KOOK state
  kook: KookConfig | null
  kookIsLoading: boolean
  kookGatewayStatus: KookGatewayStatusResponse
  kookHasChanges: boolean
  kookIsTesting: boolean
  kookTestResult: { success: boolean; message: string } | null

  // WeCom state
  wecom: WeComConfig | null
  wecomIsLoading: boolean
  wecomGatewayStatus: WeComGatewayStatusResponse
  wecomHasChanges: boolean
  wecomIsTesting: boolean
  wecomTestResult: { success: boolean; message: string } | null

  // WeChat state
  wechat: WeChatConfig | null
  wechatIsLoading: boolean
  wechatGatewayStatus: WeChatGatewayStatusResponse
  wechatHasChanges: boolean
  wechatIsTesting: boolean
  wechatTestResult: { success: boolean; message: string } | null

  // Actions
  loadConfig: () => Promise<void>
  saveDiscordConfig: (config: DiscordConfig) => Promise<void>
  startGateway: () => Promise<void>
  stopGateway: () => Promise<void>
  refreshStatus: () => Promise<void>
  testToken: (token: string) => Promise<boolean>
  clearError: () => void
  clearTestResult: () => void
  setHasChanges: (hasChanges: boolean) => void

  // Feishu actions
  loadFeishuConfig: () => Promise<void>
  saveFeishuConfig: (config: FeishuConfig) => Promise<void>
  startFeishuGateway: () => Promise<void>
  stopFeishuGateway: () => Promise<void>
  refreshFeishuStatus: () => Promise<void>
  testFeishuCredentials: (appId: string, appSecret: string) => Promise<boolean>
  clearFeishuTestResult: () => void
  setFeishuHasChanges: (hasChanges: boolean) => void

  // Email actions
  loadEmailConfig: () => Promise<void>
  saveEmailConfig: (config: EmailConfig) => Promise<void>
  startEmailGateway: () => Promise<void>
  stopEmailGateway: () => Promise<void>
  refreshEmailStatus: () => Promise<void>
  testEmailConnection: (config: EmailConfig) => Promise<boolean>
  gmailAuthorize: (clientId: string, clientSecret: string, email: string) => Promise<boolean>
  checkGmailAuth: () => Promise<boolean>
  clearEmailTestResult: () => void
  setEmailHasChanges: (hasChanges: boolean) => void

  // KOOK actions
  loadKookConfig: () => Promise<void>
  saveKookConfig: (config: KookConfig) => Promise<void>
  startKookGateway: () => Promise<void>
  stopKookGateway: () => Promise<void>
  refreshKookStatus: () => Promise<void>
  testKookToken: (token: string) => Promise<boolean>
  clearKookTestResult: () => void
  setKookHasChanges: (hasChanges: boolean) => void

  // WeCom actions
  loadWecomConfig: () => Promise<void>
  saveWecomConfig: (config: WeComConfig) => Promise<void>
  startWecomGateway: () => Promise<void>
  stopWecomGateway: () => Promise<void>
  refreshWecomStatus: () => Promise<void>
  testWecomCredentials: (botId: string, secret: string) => Promise<boolean>
  clearWecomTestResult: () => void
  setWecomHasChanges: (hasChanges: boolean) => void
  startWecomQrAuth: () => Promise<WeComQrAuthStart>
  pollWecomQrAuth: (scode: string) => Promise<WeComQrAuthPollResult>

  // WeChat actions
  loadWechatConfig: () => Promise<void>
  saveWechatConfig: (config: WeChatConfig) => Promise<void>
  startWechatGateway: () => Promise<void>
  stopWechatGateway: () => Promise<void>
  refreshWechatStatus: () => Promise<void>
  testWechatConnection: (botToken: string) => Promise<boolean>
  clearWechatTestResult: () => void
  setWechatHasChanges: (hasChanges: boolean) => void

  // Toggle enabled and persist immediately
  toggleDiscordEnabled: (enabled: boolean, config: DiscordConfig) => Promise<void>
  toggleFeishuEnabled: (enabled: boolean, config: FeishuConfig) => Promise<void>
  toggleEmailEnabled: (enabled: boolean, config: EmailConfig) => Promise<void>
  toggleKookEnabled: (enabled: boolean, config: KookConfig) => Promise<void>
  toggleWecomEnabled: (enabled: boolean, config: WeComConfig) => Promise<void>
  toggleWechatEnabled: (enabled: boolean, config: WeChatConfig) => Promise<void>

  // Auto-start enabled gateways
  autoStartEnabledGateways: () => Promise<void>

  // Keep-alive: check all enabled channels and restart if disconnected/errored
  keepAliveCheck: () => Promise<void>

  // Stop all gateways and reset state (for workspace switching)
  stopAllAndReset: () => Promise<void>
}
