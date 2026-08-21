import { cloudApiBaseUrl, supabaseAccessToken } from "../../lib/cloud-api/client";
import { createCloudShortcutsApi, type ShortcutsApi } from "./cloud-api";

// Cloud API is the only client backend. The auth client is used here purely as
// the bearer-token source; all shortcut data operations go through the Cloud API.
export function createConfiguredShortcutsApi(
  client: Parameters<typeof supabaseAccessToken>[0],
): ShortcutsApi {
  return createCloudShortcutsApi({
    baseUrl: cloudApiBaseUrl(),
    getAccessToken: supabaseAccessToken(client),
  });
}
