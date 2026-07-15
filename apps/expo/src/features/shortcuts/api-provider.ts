import { supabaseAccessToken } from "../../lib/cloud-api/client";
import { createCloudShortcutsApi, type ShortcutsApi } from "./cloud-api";

// Cloud API is the only client backend. The auth client is used here purely as
// the bearer-token source; all shortcut data operations go through the Cloud API.
export function createConfiguredShortcutsApi(
  client: Parameters<typeof supabaseAccessToken>[0],
): ShortcutsApi {
  const baseUrl = process.env.EXPO_PUBLIC_CLOUD_API_URL?.trim();
  if (!baseUrl) {
    throw new Error("EXPO_PUBLIC_CLOUD_API_URL is required (cloud_api is the only backend).");
  }
  return createCloudShortcutsApi({
    baseUrl,
    getAccessToken: supabaseAccessToken(client),
  });
}
