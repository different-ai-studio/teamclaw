// Build-time configuration injected by Vite's `define` from build.config.json.
// See build.config.example.json for all available fields.

export interface ChannelsFeatureConfig {
  discord: boolean
  feishu: boolean
  email: boolean
  kook: boolean
  wecom: boolean
  wechat: boolean
}

export interface BuildConfig {
  team: {
    llm: {
      baseUrl: string
      model: string
      modelName: string
      supportsVision?: boolean
    }
    lockLlmConfig: boolean
  }
  app: {
    name: string
  }
  features: {
    advancedMode: boolean
    teamMode: boolean
    updater: boolean
    channels: boolean | ChannelsFeatureConfig
  }
  oss?: {
    fcEndpoint: string
  }
  defaults: {
    locale: string
    theme: string
  }
}

const allChannelsEnabled: ChannelsFeatureConfig = {
  discord: true,
  feishu: true,
  email: true,
  kook: true,
  wecom: true,
  wechat: true,
}

/**
 * Normalize channels config: `true` → all enabled, `false` → all disabled, object → as-is.
 */
export function resolveChannelsConfig(channels: boolean | ChannelsFeatureConfig): ChannelsFeatureConfig {
  if (typeof channels === 'boolean') {
    return channels
      ? { ...allChannelsEnabled }
      : { discord: false, feishu: false, email: false, kook: false, wecom: false, wechat: false }
  }
  return channels
}

/** Whether at least one channel is enabled. */
export function hasAnyChannel(channels: boolean | ChannelsFeatureConfig): boolean {
  if (typeof channels === 'boolean') return channels
  return Object.values(channels).some(Boolean)
}

const fallback: BuildConfig = {
  team: {
    llm: { baseUrl: '', model: '', modelName: '', supportsVision: false },
    lockLlmConfig: false,
  },
  app: { name: 'TeamClaw' },
  features: { advancedMode: true, teamMode: true, updater: true, channels: { ...allChannelsEnabled } },
  defaults: { locale: 'zh-CN', theme: 'system' },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(base: any, override: any): any {
  if (!override) return base
  const result = { ...base }
  for (const key of Object.keys(override)) {
    const baseVal = result[key]
    const overVal = override[key]
    if (
      baseVal && overVal &&
      typeof baseVal === 'object' && !Array.isArray(baseVal) &&
      typeof overVal === 'object' && !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(baseVal, overVal)
    } else if (overVal !== undefined) {
      result[key] = overVal
    }
  }
  return result
}

export const buildConfig: BuildConfig = typeof __BUILD_CONFIG__ !== 'undefined' && __BUILD_CONFIG__
  ? deepMerge(fallback, __BUILD_CONFIG__) as BuildConfig
  : fallback
