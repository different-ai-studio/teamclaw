// Build-time configuration injected by Vite's `define` from build.config.json.
// See build.config.example.json for all available fields.

import {
  DEFAULT_EXTENSION_PACK_CONFIG,
  parseExtensionPackConfig,
  type ExtensionPackConfig,
  type ExtensionSettingsBake,
} from './extension-settings-bake'

export type {
  ExtensionSettingsBake,
  ExtensionLinkHoverBake,
  ExtensionPackConfig,
} from './extension-settings-bake'


export interface ChannelsFeatureConfig {
  discord: boolean
  feishu: boolean
  email: boolean
  kook: boolean
  wecom: boolean
  wechat: boolean
  seatalk: boolean
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
  /** Browser MQTT-over-WebSocket endpoint (ws/wss, e.g.
   *  wss://mqtt.example.com/mqtt), overriding the TCP broker that
   *  `/v1/config/bootstrap` hands out. Web/extension builds only — a
   *  chrome-extension:// secure context cannot reach a plaintext broker. Read by
   *  `apps/extension/build.mjs`, which passes it to vite as VITE_MQTT_WS_URL so
   *  a brand's package points at the brand's broker; the desktop build ignores
   *  it and keeps using the bootstrap address. Also accepted under the
   *  `extension` / `extensions` block. */
  mqttWsUrl?: string
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
     *  should differ from the bundle name (e.g. name "TeamClu" keeps the .app
     *  and download URL clean while displayName "TeamClu 龙虾团" shows in the UI). */
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
     *  "com.acme.app"). Omitted → keep the default com.teamclu.app. */
    identifier?: string
    /** Build-time white-label: deep-link URL scheme (e.g. "acme" →
     *  acme://invite?token=…). Omitted → "teamclu". */
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
      /** Email + password sign-in. Off by default; enable per build. */
      password?: boolean
      /** "快捷登录" — harvest a shared session from the partner admin console
       *  webview. Off by default. The sign-in URL + storage key are delivered
       *  at runtime by the Cloud API (`WEBSSO_LOGIN_URL` / `WEBSSO_STORAGE_KEY`),
       *  never hardcoded here. */
      webSSO?: boolean
      /** Admin console hosts allowed to receive an injected TeamClu session.
       *  Consumed by build.rs (baked into WEBSSO_ADMIN_HOSTS) as the native-side
       *  re-check; deployment-specific hosts belong in a brand build config. */
      webSSOHosts?: string[]
    }
    /** Apps module: build full-stack apps (per-app workspace/git + FC deploy).
     *  Off by default; on in build.config.dev.json. Enabling it in a shipped
     *  build also needs the deploy env (CODEUP_*, APPS_DB_ADMIN_URL,
     *  APPS_FC_ENDPOINT/ALIYUN_ACCOUNT_ID) on that build's Cloud API, or deploy
     *  answers 503 deploy_unavailable. */
    apps?: boolean
  }
  /** Which local agent runtime this build targets. "opencode" (default) drives
   *  the official opencode over `opencode serve` HTTP; "pi" selects the pi
   *  coding-agent RPC backend; "cursor" selects the Cursor SDK bridge
   *  (see docs/architecture/cursor-sdk-backend.md).
   *  Flows into the daemon config (`agents.local_agent`) during onboarding. */
  localAgent?: 'opencode' | 'pi' | 'cursor' | 'claude-code' | 'claude_code' | 'claude'
  defaults: {
    theme: string
  }
  /**
   * Chrome extension pack options (`solo`, side-panel `domains`, `settings`).
   * Sole source for extension packaging — no SOLO/DOMAINS CLI overrides.
   */
  extensions?: Partial<ExtensionPackConfig> & {
    settings?: Partial<ExtensionSettingsBake> & {
      linkHover?: Partial<ExtensionSettingsBake['linkHover']>
    }
  }
}

const allChannelsEnabled: ChannelsFeatureConfig = {
  discord: true,
  feishu: true,
  email: true,
  kook: true,
  wecom: true,
  wechat: true,
  seatalk: true,
}

/**
 * Normalize channels config: `true` → all enabled, `false` → all disabled, object → as-is.
 */
export function resolveChannelsConfig(channels: boolean | ChannelsFeatureConfig): ChannelsFeatureConfig {
  if (typeof channels === 'boolean') {
    return channels
      ? { ...allChannelsEnabled }
      : { discord: false, feishu: false, email: false, kook: false, wecom: false, wechat: false, seatalk: false }
  }
  return channels
}

/** Whether at least one channel is enabled. */
export function hasAnyChannel(channels: boolean | ChannelsFeatureConfig): boolean {
  if (typeof channels === 'boolean') return channels
  return Object.values(channels).some(Boolean)
}

/**
 * Values used when no `build.config.*.json` is baked in.
 *
 * Exported because it is a contract worth asserting on: features that must be
 * opt-in (webSSO) have to default off here, and a test that reads the merged
 * `buildConfig` instead cannot check that — locally the merge has already
 * layered `build.config.dev.json` on top.
 */
export const FALLBACK_BUILD_CONFIG: BuildConfig = {
  team: {
    lockLlmConfig: false,
  },
  app: { name: 'TeamClu', shortName: 'teamclu' },
  features: { updater: true, channels: { ...allChannelsEnabled }, auth: { google: false, wechat: false, phone: false, password: false, webSSO: false }, apps: false },
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
  ? deepMerge(FALLBACK_BUILD_CONFIG, __BUILD_CONFIG__) as BuildConfig
  : FALLBACK_BUILD_CONFIG

function deriveShortName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

const OFFICIAL_BRAND_SHORT_NAMES = new Set(['teamclu', 'teamcludev'])

/** Official TeamClu Prod/Dev builds share one on-disk + localStorage namespace. */
export function isOfficialBrand(shortName: string): boolean {
  return OFFICIAL_BRAND_SHORT_NAMES.has(shortName)
}

/** Home dir + localStorage prefix (`teamclu` for official builds). */
export function resolveStorageDirName(shortName: string): string {
  return isOfficialBrand(shortName) ? 'teamclu' : shortName
}

/**
 * Local amuxd state folder under `$HOME` (no leading dot).
 * Official → `amuxd` (`~/.amuxd`); white-label → `amuxd-<brand>`.
 */
export function resolveAmuxdDirName(shortName: string): string {
  return isOfficialBrand(shortName) ? 'amuxd' : `amuxd-${shortName}`
}

export const appShortName: string = buildConfig.app.shortName ?? deriveShortName(buildConfig.app.name)
/** Prefix for localStorage keys — unified `teamclu` for official builds (Decision 1 = B). */
export const appStoragePrefix: string = resolveStorageDirName(appShortName)
/** The product name to show users. Prefer this over `buildConfig.app.name` in
 *  any UI string — `app.name` is the bundle identity and may differ. */
export const appDisplayName: string = buildConfig.app.displayName ?? buildConfig.app.name
export const appScheme: string = buildConfig.app.scheme ?? 'teamclu'
/**
 * Local agent runtime for this build. Defaults to opencode.
 *
 * This value is what onboarding seeds into `agents.local_agent`, so a missing
 * arm here does not just mislabel — it ships the wrong runtime. claude-code was
 * missing, and its build.config value silently became opencode.
 */
export const localAgent: 'opencode' | 'pi' | 'cursor' | 'claude-code' =
  buildConfig.localAgent === 'pi'
    ? 'pi'
    : buildConfig.localAgent === 'cursor'
      ? 'cursor'
      : buildConfig.localAgent === 'claude-code' ||
          buildConfig.localAgent === 'claude_code' ||
          buildConfig.localAgent === 'claude'
        ? 'claude-code'
        : 'opencode'
export const DEFAULT_WORKSPACE_PATH = `~/${buildConfig.app.name}`
export const TEAMCLU_DIR = isOfficialBrand(appShortName) ? '.teamclu' : `.${appShortName}`
/** Team share link + global sync dir name. Fixed across brands so daemon, git, and all clients agree. */
export const TEAM_REPO_DIR = 'teamclu-team'
export const CONFIG_FILE_NAME = isOfficialBrand(appShortName) ? 'teamclu.json' : `${appShortName}.json`
export const TEAM_SYNCED_EVENT = `${appStoragePrefix}-team-synced`

/** Baked Chrome-extension pack config (`extensions` in build.config*.json). */
export const extensionPack: ExtensionPackConfig = parseExtensionPackConfig(
  buildConfig.extensions ?? DEFAULT_EXTENSION_PACK_CONFIG,
)

/** Baked Chrome-extension settings (`extensions.settings`). */
export const extensionSettings: ExtensionSettingsBake = extensionPack.settings

/** When true, the extension side-panel hides the settings gear button. */
export const hideExtensionSettingsButton: boolean = extensionSettings.hideButton === true

/** Solo-agent extension build (`extensions.solo`). */
export const extensionSoloBuild: boolean = extensionPack.solo === true

/** Side-panel host gate patterns (`extensions.domains`). Empty = ungated. */
export const extensionSidePanelDomains: readonly string[] = extensionPack.domains
