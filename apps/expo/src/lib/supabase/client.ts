// The expo app is cloud-only: there is no Supabase SDK client. This module
// re-exports the Cloud API auth facade under the historical `supabase` name so
// existing consumers (`supabase.auth.*`) and the `supabaseAccessToken(client)`
// bearer bridge keep working without churn. All auth I/O goes through the FC
// `/v1/auth/*` proxy + the persisted SessionStore (see `lib/auth/cloud-auth`).
export { cloudAuth as supabase } from "../auth/cloud-auth";
