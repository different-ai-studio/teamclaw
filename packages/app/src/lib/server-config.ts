import type { BackendKind } from "@/lib/backend/types";
import { buildConfig } from "@/lib/build-config";

export interface ServerConfig {
  backendKind?: BackendKind;
  cloudApiUrl?: string;
  /** Full MQTT endpoint, including the scheme and optional WebSocket path. */
  mqttUrl?: string;
  mqttHost?: string;
  mqttPort?: number;
  mqttUseTls?: boolean;
  mqttUsername?: string;
  mqttPassword?: string;
  // Web SSO 快捷登录 target, delivered by /v1/config/bootstrap (like MQTT) so
  // the admin console sign-in URL + supabase-js storage key are not hardcoded.
  webSsoLoginUrl?: string;
  webSsoStorageKey?: string;
}

// The Cloud API URL is owned entirely by the frontend build config
// (`build.config*.json` → `buildConfig.cloudApiUrl`), overridable only at
// build/dev time via the `VITE_CLOUD_API_URL` env var. There is no runtime
// override and no on-disk persistence: the legacy `~/.teamclaw/config.json`
// override (and the `window.__TEAMCLAW_SERVER_CONFIG__` injection that carried
// it) have been removed, because a stale persisted value could silently shadow
// the baked build config.
//
// This localStorage entry is a session cache for the MQTT broker config that the
// Cloud API delivers via `/v1/config/bootstrap` after sign-in — nothing else. It
// lets the MQTT client read a broker synchronously before bootstrap re-runs.
const STORAGE_KEY = "teamclaw.serverConfig";

function readLocalConfig(): ServerConfig {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ServerConfig;
  } catch {
    return {};
  }
}

function writeLocalConfig(config: ServerConfig) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/**
 * Parses VITE_MQTT_WS_URL (a full ws/wss URL) into host/port/useTls overrides.
 * Returns undefined when the env var is absent or unparseable.
 */
function parseMqttWsUrlOverride():
  | { mqttUrl: string; mqttHost: string; mqttPort: number | undefined; mqttUseTls: boolean }
  | undefined {
  const raw = import.meta.env.VITE_MQTT_WS_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const isTls = url.protocol === "wss:";
    return {
      mqttUrl: raw,
      mqttHost: url.hostname,
      // When the URL omits the port (e.g. wss://host/mqtt behind a 443 reverse
      // proxy) fall back to the scheme default rather than undefined — otherwise
      // the override leaves the port unset and the bridge defaults it to the
      // TCP broker port (1883), producing an unreachable wss://host:1883/mqtt.
      mqttPort: url.port ? Number(url.port) : isTls ? 443 : 80,
      mqttUseTls: isTls,
    };
  } catch {
    return undefined;
  }
}

function envConfig(): ServerConfig {
  const mqttPort = Number(import.meta.env.VITE_MQTT_PORT ?? "");
  const rawUseTls = import.meta.env.VITE_MQTT_USE_TLS?.trim().toLowerCase();
  const mqttUseTls =
    rawUseTls === "true" || rawUseTls === "1"
      ? true
      : rawUseTls === "false" || rawUseTls === "0"
        ? false
        : undefined;
  return {
    backendKind: "cloud_api",
    // Env var wins; otherwise fall back to the value baked into build.config.*.
    cloudApiUrl: import.meta.env.VITE_CLOUD_API_URL || buildConfig.cloudApiUrl,
    mqttUrl: import.meta.env.VITE_MQTT_URL,
    mqttHost: import.meta.env.VITE_MQTT_HOST,
    mqttPort: Number.isFinite(mqttPort) ? mqttPort : undefined,
    mqttUseTls,
    mqttUsername: import.meta.env.VITE_MQTT_USERNAME,
    mqttPassword: import.meta.env.VITE_MQTT_PASSWORD,
    webSsoLoginUrl: import.meta.env.VITE_WEBSSO_LOGIN_URL,
    webSsoStorageKey: import.meta.env.VITE_WEBSSO_STORAGE_KEY,
  };
}

// Only the bootstrap-delivered config (MQTT broker + Web SSO target) is
// persisted. cloudApiUrl and backendKind are intentionally dropped — they are
// never a runtime override.
function normalizeCachedConfig(config: ServerConfig): ServerConfig {
  return {
    mqttUrl: config.mqttUrl?.trim() || undefined,
    mqttHost: config.mqttHost?.trim() || undefined,
    mqttPort: config.mqttPort,
    mqttUseTls: config.mqttUseTls,
    mqttUsername: config.mqttUsername?.trim() || undefined,
    mqttPassword: config.mqttPassword?.trim() || undefined,
    webSsoLoginUrl: config.webSsoLoginUrl?.trim() || undefined,
    webSsoStorageKey: config.webSsoStorageKey?.trim() || undefined,
  };
}

function hasOwn(config: ServerConfig, key: keyof ServerConfig): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

function resolve(rawSaved: ServerConfig): ServerConfig {
  const saved = normalizeCachedConfig(rawSaved);
  const env = envConfig();
  // When VITE_MQTT_WS_URL is set it wins over both bootstrap and env for
  // connection params (host/port/tls). Credentials still come from bootstrap.
  const wsOverride = parseMqttWsUrlOverride();
  return {
    backendKind: "cloud_api",
    // Single source of truth: build config (env var override only). The saved
    // localStorage cache never contributes a cloudApiUrl.
    cloudApiUrl: env.cloudApiUrl,
    mqttUrl: wsOverride?.mqttUrl ?? saved.mqttUrl ?? env.mqttUrl,
    mqttHost: wsOverride ? wsOverride.mqttHost : (saved.mqttHost ?? env.mqttHost),
    mqttPort: wsOverride ? wsOverride.mqttPort : (saved.mqttPort ?? env.mqttPort),
    mqttUseTls: wsOverride ? wsOverride.mqttUseTls : (saved.mqttUseTls ?? env.mqttUseTls),
    mqttUsername: hasOwn(rawSaved, "mqttUsername") ? saved.mqttUsername : env.mqttUsername,
    mqttPassword: hasOwn(rawSaved, "mqttPassword") ? saved.mqttPassword : env.mqttPassword,
    // Web SSO target: bootstrap cache wins, dev env var as fallback.
    webSsoLoginUrl: saved.webSsoLoginUrl ?? env.webSsoLoginUrl,
    webSsoStorageKey: saved.webSsoStorageKey ?? env.webSsoStorageKey,
  };
}

export function getEffectiveServerConfigSync(): ServerConfig {
  return resolve(readLocalConfig());
}

export async function getSavedServerConfig(): Promise<ServerConfig> {
  return readLocalConfig();
}

export async function saveServerConfig(config: ServerConfig): Promise<ServerConfig> {
  const normalized = normalizeCachedConfig(config);
  writeLocalConfig(normalized);
  return { backendKind: "cloud_api", ...normalized };
}

export async function getEffectiveServerConfig(): Promise<ServerConfig> {
  return resolve(readLocalConfig());
}
