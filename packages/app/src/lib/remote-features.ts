// Runtime feature flags: the build config is the DEFAULT, the Cloud API is the
// override.
//
// `buildConfig.features` is baked at package time, so changing a flag used to
// mean shipping a new client. The Cloud API now delivers a subset of those
// flags at runtime and this module merges the two. Nothing here ever *requires*
// the network: with no snapshot and no reachable server, every value falls back
// to exactly what the build baked, which is the pre-existing behaviour.
//
// Two snapshots, two scopes, because the two endpoints answer at different
// times in the app's life:
//
//   public  — /v1/config/public, fetched at startup with no session. The login
//             screen needs `auth.*` before any token exists.
//   session — /v1/config/bootstrap, fetched after sign-in.
//
// Sign-out clears only the session snapshot. The public one is deployment-level
// config, not account data: wiping it would send the next launch's login screen
// back to the baked defaults with no way to know better until a fetch lands —
// the same shape of regression as clearing the MQTT address on sign-out (#634).

import { useSyncExternalStore } from "react";

import { buildConfig, type ChannelsFeatureConfig } from "@/lib/build-config";
import { getCloudApiUrlOverride, getDefaultCloudApiUrl } from "@/lib/server-config";

export type FeatureScope = "public" | "session";

export interface AuthFeatures {
  google: boolean;
  wechat: boolean;
  phone: boolean;
  password: boolean;
  webSSO: boolean;
}

export interface ResolvedFeatures {
  /** Build-time only, never remote — see the note on the allowlists below. */
  updater: boolean;
  auth: AuthFeatures;
  channels: ChannelsFeatureConfig;
  teamShareBrowser: boolean;
  apps: boolean;
  /** Defaults from `buildConfig.team.lockLlmConfig` — note the different path. */
  lockLlmConfig: boolean;
}

// What the server is allowed to influence, restated on the client. The server
// has its own allowlist; this is not redundancy but the half we control — a
// compromised or simply misconfigured deployment must not be able to introduce
// a flag the client never agreed to honour.
//
// `updater` is on neither list, deliberately. It gates the startup auto-check
// as well as the UI, so a remote `false` would strand the fleet with no way to
// update out of it. It stays build-time.
const AUTH_KEYS = ["google", "wechat", "phone", "password", "webSSO"] as const;
const CHANNEL_KEYS = ["discord", "feishu", "email", "kook", "wecom", "wechat"] as const;
const BOOL_KEYS = ["teamShareBrowser", "apps", "lockLlmConfig"] as const;

export interface RemoteFeaturePatch {
  auth?: Partial<AuthFeatures>;
  channels?: Partial<ChannelsFeatureConfig>;
  teamShareBrowser?: boolean;
  apps?: boolean;
  lockLlmConfig?: boolean;
}

function pickBooleans<K extends string>(
  source: unknown,
  keys: readonly K[],
): Partial<Record<K, boolean>> | undefined {
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const out: Partial<Record<K, boolean>> = {};
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    // Non-booleans are dropped rather than coerced: a "false" string would
    // otherwise switch on the very thing it was written to switch off.
    if (typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Keep only known keys with the right types. Anything else is discarded. */
export function sanitizeRemoteFeatures(raw: unknown): RemoteFeaturePatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const patch: RemoteFeaturePatch = {};
  const auth = pickBooleans(source.auth, AUTH_KEYS);
  if (auth) patch.auth = auth;
  const channels = pickBooleans(source.channels, CHANNEL_KEYS);
  if (channels) patch.channels = channels;
  for (const key of BOOL_KEYS) {
    if (typeof source[key] === "boolean") patch[key] = source[key] as boolean;
  }
  return patch;
}

/**
 * Every key has exactly ONE authoritative endpoint, and this is where the
 * client enforces it: `auth` is public-scope only, everything else is
 * session-scope only.
 *
 * Without this, the same flag could arrive from both endpoints and the winner
 * would be whichever fetch happened to land last — a race that would show up as
 * a flag that "sometimes" applies. Dropping the out-of-scope keys makes the
 * ownership rule structural rather than a convention the server has to honour.
 */
function scopeToOwnedKeys(scope: FeatureScope, patch: RemoteFeaturePatch): RemoteFeaturePatch {
  if (scope === "public") return patch.auth ? { auth: patch.auth } : {};
  const { auth: _ignored, ...rest } = patch;
  return rest;
}

// ---------------------------------------------------------------------------
// Snapshot storage
// ---------------------------------------------------------------------------

// Partitioned by Cloud API origin. Pointing the app at a different server must
// not inherit the previous server's flags — and because the key changes with
// the origin, that falls out of the key rather than needing an explicit
// invalidation step that could be forgotten.
function storageKey(scope: FeatureScope, origin: string): string {
  return `teamclaw.remoteFeatures.${scope}:${origin}`;
}

/** Origin of the Cloud API this app is currently pointed at, or "" when none. */
export function currentCloudApiOrigin(): string {
  try {
    const url = getCloudApiUrlOverride() ?? getDefaultCloudApiUrl();
    return url ? new URL(url).origin : "";
  } catch {
    // An unparseable URL, or a partially mocked server-config module under
    // test. Either way: no origin, so no snapshot — the build config stands.
    return "";
  }
}

function readSnapshot(scope: FeatureScope, origin: string): RemoteFeaturePatch {
  if (typeof window === "undefined" || !origin) return {};
  try {
    const raw = window.localStorage.getItem(storageKey(scope, origin));
    if (!raw) return {};
    // Sanitize on read too, not just on write: a snapshot written by an older
    // build (or hand-edited) must not be able to smuggle in a retired key.
    return sanitizeRemoteFeatures(JSON.parse(raw));
  } catch {
    return {};
  }
}

function writeSnapshot(scope: FeatureScope, origin: string, patch: RemoteFeaturePatch): void {
  if (typeof window === "undefined" || !origin) return;
  try {
    window.localStorage.setItem(storageKey(scope, origin), JSON.stringify(patch));
  } catch {
    // A full/blocked localStorage must not break feature resolution — the
    // in-memory value below still applies for this session.
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

// Normalizing `channels` here rather than importing build-config's helper is
// deliberate. This module sits in the import graph of nearly every gated
// surface, including suites that partially mock @/lib/build-config; depending
// on one more of that module's exports turns an unrelated test's mock into an
// import-time crash. Same reason every read below is defensive.
function normalizeChannels(value: boolean | ChannelsFeatureConfig | undefined): ChannelsFeatureConfig {
  if (value === undefined) value = true;
  if (typeof value === "boolean") {
    return {
      discord: value,
      feishu: value,
      email: value,
      kook: value,
      wecom: value,
      wechat: value,
      seatalk: value,
    };
  }
  return value;
}

function resolveFrom(patches: RemoteFeaturePatch[]): ResolvedFeatures {
  const base = buildConfig?.features ?? {};
  const baseAuth = base.auth ?? {};
  const merged: RemoteFeaturePatch = {};
  for (const patch of patches) {
    Object.assign(merged, patch, {
      auth: { ...merged.auth, ...patch.auth },
      channels: { ...merged.channels, ...patch.channels },
    });
  }

  const channels = normalizeChannels(base.channels);
  return {
    // Never remote. See the allowlist note above. Defaults to on, matching
    // FALLBACK_BUILD_CONFIG — an absent flag must not silently disable
    // updates.
    updater: base.updater ?? true,
    auth: {
      google: merged.auth?.google ?? baseAuth.google ?? false,
      wechat: merged.auth?.wechat ?? baseAuth.wechat ?? false,
      phone: merged.auth?.phone ?? baseAuth.phone ?? false,
      password: merged.auth?.password ?? baseAuth.password ?? false,
      // ANDed, not overridden. The admin-console hosts allowed to receive an
      // injected session are compiled into the desktop binary
      // (WEBSSO_ADMIN_HOSTS, apps/desktop/build.rs), so a server that turns
      // this on cannot make it work — and a build that never opted in must not
      // be talked into it by whatever server it happens to point at.
      webSSO: Boolean(baseAuth.webSSO) && (merged.auth?.webSSO ?? Boolean(baseAuth.webSSO)),
    },
    channels: {
      discord: merged.channels?.discord ?? channels.discord,
      feishu: merged.channels?.feishu ?? channels.feishu,
      email: merged.channels?.email ?? channels.email,
      kook: merged.channels?.kook ?? channels.kook,
      wecom: merged.channels?.wecom ?? channels.wecom,
      wechat: merged.channels?.wechat ?? channels.wechat,
      seatalk: merged.channels?.seatalk ?? channels.seatalk,
    },
    teamShareBrowser: merged.teamShareBrowser ?? base.teamShareBrowser ?? false,
    apps: merged.apps ?? base.apps ?? false,
    // Lives under `team`, not `features`, in the build config.
    lockLlmConfig: merged.lockLlmConfig ?? buildConfig?.team?.lockLlmConfig ?? false,
  };
}

// In-memory mirror of the two snapshots, seeded synchronously at module load so
// the very first paint (the login screen) already has the last known answer.
let originAtLoad = currentCloudApiOrigin();
const patches: Record<FeatureScope, RemoteFeaturePatch> = {
  public: readSnapshot("public", originAtLoad),
  session: readSnapshot("session", originAtLoad),
};

type Listener = (features: ResolvedFeatures) => void;
const listeners = new Set<Listener>();
let resolved: ResolvedFeatures = resolveFrom([patches.public, patches.session]);

function recompute(): void {
  const next = resolveFrom([patches.public, patches.session]);
  // Cheap structural compare: this runs on every fetch, and re-rendering the
  // whole feature-gated UI because the server repeated itself is pure churn.
  if (JSON.stringify(next) === JSON.stringify(resolved)) return;
  resolved = next;
  for (const listener of listeners) listener(resolved);
}

/** Current effective flags. Safe to call before any fetch has completed. */
export function getFeatures(): ResolvedFeatures {
  return resolved;
}

export function subscribeFeatures(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Store a `features` block delivered by the Cloud API. Unknown/ill-typed keys
 * are dropped; an absent or empty block is a no-op rather than "disable
 * everything" — the server answering `{}` means "no overrides", and reading it
 * as "all off" is exactly how #634 turned a quiet server into an outage.
 */
export function applyRemoteFeatures(scope: FeatureScope, raw: unknown): void {
  const patch = scopeToOwnedKeys(scope, sanitizeRemoteFeatures(raw));
  const origin = currentCloudApiOrigin();
  patches[scope] = patch;
  writeSnapshot(scope, origin, patch);
  recompute();
}

/**
 * Drop the post-sign-in snapshot. Called from auth-store.signOut alongside the
 * other per-account state. The public snapshot deliberately survives.
 */
export function clearSessionFeatures(): void {
  patches.session = {};
  const origin = currentCloudApiOrigin();
  if (typeof window !== "undefined" && origin) {
    try {
      window.localStorage.removeItem(storageKey("session", origin));
    } catch {
      /* ignore */
    }
  }
  recompute();
}

/**
 * Re-seed from storage for the current origin. Called when the Cloud API URL
 * changes.
 *
 * Today the "Custom server" flow reloads the whole window right after writing
 * the override, so module load would re-seed anyway — but that is a property of
 * one caller, not a guarantee. Wiring this to the change notification keeps the
 * behaviour correct if an in-place server switch is ever added.
 */
export function reloadFeaturesForCurrentOrigin(): void {
  originAtLoad = currentCloudApiOrigin();
  patches.public = readSnapshot("public", originAtLoad);
  patches.session = readSnapshot("session", originAtLoad);
  recompute();
}

// Switching backends re-seeds from that backend's own snapshots. Today the
// "Custom server" flow reloads the window immediately afterwards, which would
// do the same thing — this makes it hold even if that ever stops being true.
//
// The event name is duplicated from CLOUD_API_URL_CHANGED_EVENT in
// lib/server-config rather than imported: importing a const from a module that
// suites partially mock makes THIS module unimportable in those suites, which
// is a worse coupling than one repeated string literal.
if (typeof window !== "undefined") {
  window.addEventListener("teamclaw:cloud-api-url-changed", () =>
    reloadFeaturesForCurrentOrigin(),
  );
}

/** Test seam: forget everything in memory and re-read storage. */
export function __resetFeaturesForTest(): void {
  reloadFeaturesForCurrentOrigin();
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

/**
 * Subscribe a component to the effective flags.
 *
 * Every gated surface must read through this rather than the build config: the
 * flags now arrive mid-session, and a value captured at module scope (the old
 * `const channels = resolveChannelsConfig(buildConfig.features.channels)`
 * pattern) can never observe that.
 *
 * `getFeatures` returns a stable reference until something actually changes,
 * so this is safe as a useSyncExternalStore snapshot.
 */
export function useFeatures(): ResolvedFeatures {
  return useSyncExternalStore(subscribeFeatures, getFeatures, getFeatures);
}

export function useFeature<K extends keyof ResolvedFeatures>(key: K): ResolvedFeatures[K] {
  return useFeatures()[key];
}
