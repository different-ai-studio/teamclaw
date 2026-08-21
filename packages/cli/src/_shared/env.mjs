/** Shared env resolution for all domains. */

const DEFAULT_API_BASE = "https://api.teamclu-dev.ucar.cc";

/**
 * Prefer domain-specific vars, then TEAMCLU_* generics.
 * @param {{ apiBase?: string[]; secret?: string[] }} keys
 */
export function resolveApiEnv(keys = {}) {
  const apiKeys = keys.apiBase ?? [
    "MARKETPLACE_API_BASE",
    "TEAMCLU_API_BASE",
  ];
  const secretKeys = keys.secret ?? [
    "MARKETPLACE_ADMIN_SECRET",
    "TEAMCLU_ADMIN_SECRET",
  ];

  let base = DEFAULT_API_BASE;
  for (const k of apiKeys) {
    const v = process.env[k]?.trim();
    if (v) {
      base = v;
      break;
    }
  }
  base = base.replace(/\/$/, "");

  let secret = "";
  for (const k of secretKeys) {
    const v = process.env[k]?.trim();
    if (v) {
      secret = v;
      break;
    }
  }

  return { base, secret };
}
