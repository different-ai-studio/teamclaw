// Postgres identifiers are max 63 bytes. Names are interpolated into DDL
// (CREATE SCHEMA/ROLE cannot be parameterized), so callers re-assert the output
// matches /^[a-z0-9_]+$/ before use; the sanitizer guarantees that here.
const MAX_LEN = 63;

function sanitize(input: string, prefix: string): string {
  const body = input.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `${prefix}${body}`.slice(0, MAX_LEN);
}

// The role name is derived from the globally-unique appId, so it is unique.
export function appRoleName(appId: string): string {
  return sanitize(appId, "app_");
}

// The schema lives in the SHARED teamclaw_apps database across ALL teams, while
// slugs are only unique per-team — so the schema name MUST carry the globally
// unique appId to avoid cross-team collisions. Layout: app_<slug>_<appIdHex>,
// with the slug portion truncated so the full 32-char appId hex suffix always
// fits within the 63-byte limit (4 prefix + 26 slug + 1 sep + 32 hex = 63).
export function appSchemaName(slug: string, appId: string): string {
  const idHex = appId.replace(/[^a-f0-9]/gi, "").toLowerCase();
  const slugBody = slug.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 26);
  return `app_${slugBody}_${idHex}`.slice(0, MAX_LEN);
}
