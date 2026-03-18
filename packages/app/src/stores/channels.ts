// channels.ts -- barrel file re-exporting everything for backwards compatibility
// All implementation has been split into focused modules:
//   channels-store.ts         -- Zustand create() composing all channel action creators
//   channels-types.ts         -- All type/interface definitions and default configs
//   channels/discord.ts       -- Discord-specific actions
//   channels/feishu.ts        -- Feishu-specific actions
//   channels/email.ts         -- Email-specific actions
//   channels/kook.ts          -- KOOK-specific actions
//   channels/wecom.ts         -- WeCom-specific actions

// Store
export { useChannelsStore } from './channels-store'

// Re-export all types from channels-types.ts
export type {
  GatewayStatus,
  DmConfig,
  ChannelRule,
  GuildConfig,
  RetryConfig,
  DiscordConfig,
  FeishuChatConfig,
  FeishuConfig,
  FeishuGatewayStatus,
  FeishuGatewayStatusResponse,
  EmailProvider,
  EmailConfig,
  EmailGatewayStatus,
  EmailGatewayStatusResponse,
  KookDmConfig,
  KookChannelRule,
  KookGuildConfig,
  KookConfig,
  KookGatewayStatus,
  KookGatewayStatusResponse,
  WeComConfig,
  WeComGatewayStatus,
  WeComGatewayStatusResponse,
  ChannelsConfig,
  GatewayStatusResponse,
  ChannelsState,
} from './channels-types'

// Re-export default configs
export {
  defaultWeComConfig,
  defaultDmConfig,
  defaultDiscordConfig,
  defaultFeishuConfig,
  defaultKookDmConfig,
  defaultKookConfig,
  defaultEmailConfig,
} from './channels-types'
