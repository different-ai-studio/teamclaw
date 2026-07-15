import { supabaseAccessToken } from "../../lib/cloud-api/client";
import { createCloudSessionsApi } from "./cloud-api";

export function createConfiguredSessionsApi(
  client: Parameters<typeof supabaseAccessToken>[0],
) {
  return createCloudSessionsApi({ getAccessToken: supabaseAccessToken(client) });
}
