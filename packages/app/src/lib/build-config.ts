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
   *  default backend endpoint. The VITE_CLOUD_API_URL env var overrides it at
   *  build/dev time; at runtime an explicit user override (the "Custom server"
   *  entry in onboarding) wins over both — see lib/server-config.ts. */
  cloudApiUrl?: string
  team: {
    lockLlmConfig: boolean
  }
  app: {
    /** Bundle identity: drives `productName`, the .app / installer filename, and
     *  the derived `shortName`. Keep it filename-clean (ASCII, no spaces is
     *  safest) — for the human-facing label use `displayName` instead. */
    name: string
    /** Human-facing label: the window title and every in-app mention of the
     *  product. Omitted → falls back to `app.name`. Set this when the UI name
     *  should differ from the bundle name (e.g. name "TeamClaw" keeps the .app
     *  and download URL clean while displayName "TeamClaw 龙虾团" shows in the UI). */
    displayName?: string
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
      /** "快捷登录" — harvest a shared session from the partner admin console
       *  webview. Off by default. The sign-in URL + storage key are delivered
       *  at runtime by the Cloud API (`WEBSSO_LOGIN_URL` / `WEBSSO_STORAGE_KEY`),
       *  never hardcoded here. */
      webSSO?: boolean
      /** Admin console hosts allowed to receive an injected TeamClaw session.
       *  Consumed by build.rs (baked into WEBSSO_ADMIN_HOSTS) as the native-side
       *  re-check; deployment-specific hosts belong in a brand build config. */
      webSSOHosts?: string[]
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
  /** Which local agent runtime this build targets. "opencode" (default) drives
   *  the official opencode over `opencode serve` HTTP; "pi" selects the pi
   *  coding-agent RPC backend (see docs/architecture/pi-agent-backend.md).
   *  Flows into the daemon config (`agents.local_agent`) during onboarding. */
  localAgent?: 'opencode' | 'pi'
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
/** The product name to show users. Prefer this over `buildConfig.app.name` in
 *  any UI string — `app.name` is the bundle identity and may differ. */
export const appDisplayName: string = buildConfig.app.displayName ?? buildConfig.app.name
export const appScheme: string = buildConfig.app.scheme ?? 'teamclaw'
/** Local agent runtime for this build. Defaults to opencode. */
export const localAgent: 'opencode' | 'pi' = buildConfig.localAgent === 'pi' ? 'pi' : 'opencode'
export const DEFAULT_WORKSPACE_PATH = `~/${buildConfig.app.name}`
export const TEAMCLAW_DIR = `.${appShortName}`
/** Team share link + global sync dir name. Fixed across brands so daemon, git, and all clients agree. */
export const TEAM_REPO_DIR = 'teamclaw-team'
export const CONFIG_FILE_NAME = `${appShortName}.json`
export const TEAM_SYNCED_EVENT = `${appShortName}-team-synced`
