import AsyncStorage from "@react-native-async-storage/async-storage";
import { cloudApiBaseUrl, createCloudApiClient } from "../cloud-api/client";

// The broker address is env-driven server-side and delivered by
// `GET /v1/config/bootstrap`, not baked into the bundle: a broker that moves
// must not require an app release. The last address is cached so a cold or
// offline launch can still connect.

const CACHE_KEY = "teamclaw.mqtt.broker-url";

type StorageLike = Pick<typeof AsyncStorage, "getItem" | "setItem" | "removeItem">;

type BootstrapConfig = {
  mqtt?: { url?: string; tcpUrl?: string } | null;
};

let lastResolvedUrl: string | null = null;

/** An explicit build-time override always wins (local dev against a test broker). */
export function getMqttUrlOverride(): string | null {
  const url = process.env.EXPO_PUBLIC_MQTT_URL?.trim();
  return url && url.length > 0 ? url : null;
}

/**
 * The address most recently resolved in this process, for UI and controllers
 * that need it synchronously. Null until the first `resolveMqttUrl` — which the
 * root layout runs before it connects, so screens downstream of a live
 * connection always see an address.
 */
export function getKnownMqttUrl(): string | null {
  return getMqttUrlOverride() ?? lastResolvedUrl;
}

/** Last broker address handed out by the Cloud API, or null if never fetched. */
export async function getCachedMqttUrl(
  storage: StorageLike = AsyncStorage,
): Promise<string | null> {
  const cached = (await storage.getItem(CACHE_KEY))?.trim();
  return cached && cached.length > 0 ? cached : null;
}

/**
 * Forget the cached broker. Called on sign-out.
 *
 * The cache exists so a cold or offline launch can still connect, but it
 * outlives the account it was fetched for. Sign out of one deployment and into
 * another on the same device and the fallback would hand the new session the
 * old deployment's broker — which it would then dial with the new user's token,
 * failing in a way that looks like a broker outage rather than stale config.
 *
 * Best-effort: a storage error here must not block sign-out, and the in-process
 * value is dropped either way, so the next resolve starts from the API.
 */
export async function clearCachedMqttUrl(
  storage: StorageLike = AsyncStorage,
): Promise<void> {
  lastResolvedUrl = null;
  try {
    await storage.removeItem(CACHE_KEY);
  } catch {
    // Nothing actionable — the in-process value is already cleared.
  }
}

/**
 * Resolve the broker address: build-time override → Cloud API → cached address
 * from the last successful fetch. Returns null when none of the three yields an
 * address, in which case the caller simply does not connect — there is no
 * bundled host to fall back on, because an address baked into a release
 * outlives the server it points at.
 */
export async function resolveMqttUrl(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  storage?: StorageLike;
}): Promise<string | null> {
  const override = getMqttUrlOverride();
  if (override) return override;

  const storage = args.storage ?? AsyncStorage;
  try {
    const client = createCloudApiClient({
      baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
      getAccessToken: args.getAccessToken,
      fetchImpl: args.fetchImpl,
    });
    const config = await client.get<BootstrapConfig>("/v1/config/bootstrap");
    // `tcpUrl` first: the native MQTT client dials the raw broker, while `url`
    // may be the WebSocket address meant for browsers.
    const url = (config.mqtt?.tcpUrl ?? config.mqtt?.url)?.trim();
    if (url) {
      await storage.setItem(CACHE_KEY, url);
      lastResolvedUrl = url;
      return url;
    }
  } catch {
    // Offline, unauthenticated, or the endpoint is unavailable — fall through
    // to whatever the last successful fetch cached.
  }
  const cached = await getCachedMqttUrl(storage);
  if (cached) lastResolvedUrl = cached;
  return cached;
}
