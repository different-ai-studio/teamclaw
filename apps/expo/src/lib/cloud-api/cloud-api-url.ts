import AsyncStorage from "@react-native-async-storage/async-storage";

import { normalizeServerEndpoint } from "./server-endpoint";

/**
 * User-chosen Cloud API base URL. Separate from the MQTT broker cache — written
 * only by an explicit "Custom server" action on the login flow. Wins over
 * `EXPO_PUBLIC_CLOUD_API_URL`. Mirrors iOS `teamclu_cloud_api_url` /
 * desktop `teamclu.cloudApiUrl.override`.
 */
export const CLOUD_API_URL_OVERRIDE_KEY = "teamclu.cloudApiUrl.override";

type StorageLike = Pick<typeof AsyncStorage, "getItem" | "setItem" | "removeItem">;

/** `undefined` until `hydrateCloudApiUrl` runs; then `string | null`. */
let overrideCache: string | null | undefined;

/** Build-time / env URL — what "Use default server" returns to. */
export function bundledCloudApiUrl(): string | null {
  const value = process.env.EXPO_PUBLIC_CLOUD_API_URL?.trim();
  return value && value.length > 0 ? value.replace(/\/+$/, "") : null;
}

/** In-memory override after hydrate (or after a save in this process). */
export function getCloudApiUrlOverride(): string | null {
  return overrideCache ?? null;
}

export function hasCloudApiUrlOverride(): boolean {
  return Boolean(overrideCache);
}

/**
 * Load the persisted override into memory. Must run before the first
 * `cloudApiBaseUrl()` consumer that matters (onboarding bootstrap).
 */
export async function hydrateCloudApiUrl(
  storage: StorageLike = AsyncStorage,
): Promise<void> {
  try {
    const raw = (await storage.getItem(CLOUD_API_URL_OVERRIDE_KEY))?.trim();
    if (!raw) {
      overrideCache = null;
      return;
    }
    const normalized = normalizeServerEndpoint(raw);
    if (!normalized) {
      // Corrupt value — drop it so launch is not wedged.
      await storage.removeItem(CLOUD_API_URL_OVERRIDE_KEY);
      overrideCache = null;
      return;
    }
    overrideCache = normalized;
  } catch {
    overrideCache = null;
  }
}

/**
 * Persist (or clear) the user-chosen Cloud API base URL. Callers must pass a
 * value from `normalizeServerEndpoint` — raw user text is not accepted.
 * Saving the bundled default clears the override (same as "Use default server").
 */
export async function setCloudApiUrlOverride(
  url: string | null,
  storage: StorageLike = AsyncStorage,
): Promise<void> {
  const bundled = bundledCloudApiUrl();
  if (url === null || (bundled !== null && url === bundled)) {
    overrideCache = null;
    try {
      await storage.removeItem(CLOUD_API_URL_OVERRIDE_KEY);
    } catch {
      // In-memory clear still stands.
    }
    return;
  }
  overrideCache = url;
  await storage.setItem(CLOUD_API_URL_OVERRIDE_KEY, url);
}

/** Test helper — reset the in-memory cache between cases. */
export function _resetCloudApiUrlCacheForTests(): void {
  overrideCache = undefined;
}
