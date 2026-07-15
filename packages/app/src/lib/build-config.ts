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

export interface TeamModelOption {
  id: string
  name: string
}

export interface BuildConfig {
  /** Cloud API base URL (e.g. https://cloud.ucar.cc) baked into the build as the
   *  default backend endpoint. Overridable at runtime via server settings or the
   *  VITE_CLOUD_API_URL env var (which takes precedence). */
  cloudApiUrl?: string
  team: {
    lockLlmConfig: boolean
  }
  app: {
    name: string
    shortName?: string
    /** Visual palette flavor. Omitted / "default" → Editorial Calm.
     *  "teal" → anodized-teal build flavor (see styles/globals.css). Applied
     *  as data-palette on <html> at first paint. */
    palette?: string
    /** Build-time white-label: path (relative to repo root) to a square source
     *  PNG (≥512px, ideally 1024×1024). When set, the prebuild step regenerates
     *  the OS icon set and the in-app logo from it. Omitted → keep committed assets. */
    logo?: string
    /** Build-time white-label: OS bundle identifier (reverse-DNS, e.g.
     *  "com.acme.app"). Omitted → keep the default com.teamclaw.app. */
    identifier?: string
    /** Build-time white-label: deep-link URL scheme (e.g. "acme" →
     *  acme://invite?token=…). Omitted → "teamclaw". */
    scheme?: string
  }
  features: {
    /** Enables the in-app updater UI (About → check/install) and the startup
     *  auto-check. The update *server* URL is configured separately via
     *  `app.updater.endpoints` (baked into tauri.conf at build time). */
    updater: boolean
    channels: boolean | ChannelsFeatureConfig
    auth?: {
      google?: boolean
      wechat?: boolean
      phone?: boolean
      /** "快捷登录" — harvest a shared session from the Betly admin webview. Off by default. */
      webSSO?: boolean
    }
    /** Browsable team-share sidebar (Skills / MCP / Env / Knowledge). Off by default. */
    teamShareBrowser?: boolean
    /** Apps module: build full-stack apps (per-app workspace/git + FC deploy).
     *  Off by default — gated until per-app FC/Postgres provisioning is live. */
    apps?: boolean
  }
  /** opencode install mirror. When `downloadBase` is set, amuxd fetches the
   *  opencode release archive from `${downloadBase}/opencode-<os>-<arch>.<ext>`
   *  instead of the official source — point this at a domestic OSS bucket for
   *  fast onboarding on slow/restricted networks. Omitted → official installer. */
  opencode?: {
    downloadBase?: string
  }
  defaults: {
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
    lockLlmConfig: false,
  },
  app: { name: 'TeamClaw', shortName: 'teamclaw' },
  features: { updater: true, channels: { ...allChannelsEnabled }, auth: { google: false, wechat: false, phone: false, webSSO: false }, teamShareBrowser: false, apps: false },
  defaults: { theme: 'system' },
}

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

function deriveShortName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

export const appShortName: string = buildConfig.app.shortName ?? deriveShortName(buildConfig.app.name)
export const appScheme: string = buildConfig.app.scheme ?? 'teamclaw'
export const DEFAULT_WORKSPACE_PATH = `~/${buildConfig.app.name}`
export const TEAMCLAW_DIR = `.${appShortName}`
/** Team share link + global sync dir name. Fixed across brands so daemon, git, and all clients agree. */
export const TEAM_REPO_DIR = 'teamclaw-team'
export const CONFIG_FILE_NAME = `${appShortName}.json`
export const TEAM_SYNCED_EVENT = `${appShortName}-team-synced`
