/**
 * daemon-local-client.ts
 *
 * Authenticated HTTP client for the daemon's local workspace-control plane.
 * Only works when running inside Tauri (desktop) because it needs to read the
 * daemon port / token files via the `get_daemon_http_info` IPC command.
 *
 * Workspace IDs passed to all API functions are base64url-encoded absolute
 * filesystem paths — use `encodeWorkspaceId(workspacePath)` to build them.
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'

// ─── Workspace ID encoding ────────────────────────────────────────────────────

/**
 * Encode an absolute workspace path into the base64url workspace-ID accepted
 * by `/v1/workspaces/:id/*` routes.
 *
 * The Rust side decodes this with `base64::URL_SAFE_NO_PAD`, so we use the
 * same alphabet (A-Z a-z 0-9 - _) with no padding.
 */
export function encodeWorkspaceId(workspacePath: string): string {
  const bytes = new TextEncoder().encode(workspacePath)
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// ─── Connection cache ─────────────────────────────────────────────────────────

interface DaemonHttpInfo {
  base_url: string
  root_token: string
}

interface DaemonConnection {
  baseUrl: string
  sessionToken: string
  /** Expiry time (ms since epoch). Re-exchange when this is in the past. */
  expiresAt: number
}

let _connection: DaemonConnection | null = null
let _inflight: Promise<DaemonConnection | null> | null = null

async function readDaemonHttpInfo(): Promise<DaemonHttpInfo | null> {
  try {
    return await invoke<DaemonHttpInfo | null>('get_daemon_http_info')
  } catch {
    return null
  }
}

function formatFetchNetworkError(baseUrl: string, raw: string): string {
  if (/load failed|failed to fetch|networkerror|econnrefused|connection refused/i.test(raw)) {
    return `Cannot reach amuxd daemon at ${baseUrl}. The daemon may have restarted on a new port — restart TeamClaw or wait a moment and retry.`
  }
  return raw
}

/** Cached connection; null if daemon HTTP is unavailable. */
async function getConnection(): Promise<DaemonConnection | null> {
  if (!isTauri()) return null

  const info = await readDaemonHttpInfo()
  if (!info) return null

  // amuxd binds a new loopback port on every restart; drop stale cache entries.
  if (_connection && _connection.baseUrl !== info.base_url) {
    invalidateDaemonConnection()
  }

  // Return cached session when still valid (5 min buffer before expiry).
  if (_connection && Date.now() < _connection.expiresAt - 5 * 60 * 1000) {
    return _connection
  }

  // Coalesce concurrent callers.
  if (_inflight) return _inflight
  _inflight = _fetchConnection(info).finally(() => {
    _inflight = null
  })
  return _inflight
}

async function _fetchConnection(info?: DaemonHttpInfo | null): Promise<DaemonConnection | null> {
  const resolved = info ?? (await readDaemonHttpInfo())
  if (!resolved) return null

  // Exchange root token for a scoped session token.
  try {
    const resp = await fetch(`${resolved.base_url}/v1/auth/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.root_token}`,
      },
      body: JSON.stringify({
        // 'admin' authorizes daemon-level config reads/writes (`/v1/config/*`,
        // e.g. switching `agents.local_agent` between opencode and pi). The
        // local desktop app owns its daemon, so it is the legitimate admin.
        scopes: ['workspace:read', 'workspace:write', 'sessions:read', 'sessions:write', 'events:read', 'admin'],
        ttl_seconds: 3600,
      }),
    })
    if (!resp.ok) {
      console.warn('[daemon-local-client] token exchange failed:', resp.status)
      return null
    }
    const data: { token?: string; expires_in?: number } = await resp.json()
    if (!data.token) return null
    _connection = {
      baseUrl: resolved.base_url,
      sessionToken: data.token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    }
    return _connection
  } catch (err) {
    console.warn('[daemon-local-client] failed to reach daemon HTTP:', err)
    return null
  }
}

/** Invalidate the cached session token (e.g. after the daemon restarts). */
export function invalidateDaemonConnection(): void {
  _connection = null
}

export type DaemonHttpProbe =
  | { ok: true; baseUrl: string }
  | {
      ok: false
      // 'port_file_missing': ~/.amuxd/amuxd.http.{port,token} absent (never started / cleaned).
      // 'not_running': port file present but /v1/healthz unreachable (daemon down / stale files).
      // 'token_invalid': healthz OK but the root token fails /v1/auth/exchange (stale token → restart).
      reason: 'not_tauri' | 'port_file_missing' | 'not_running' | 'token_invalid' | 'ipc_error'
    }

/** Probe daemon HTTP. Checks reachability (healthz) BEFORE auth so callers can
 * distinguish "daemon not running" from "token invalid" — they need different recovery. */
export async function probeDaemonHttp(): Promise<DaemonHttpProbe> {
  if (!isTauri()) return { ok: false, reason: 'not_tauri' }

  let info: DaemonHttpInfo | null
  try {
    info = await invoke<DaemonHttpInfo | null>('get_daemon_http_info')
  } catch (err) {
    console.warn('[daemon-local-client] get_daemon_http_info failed:', err)
    return { ok: false, reason: 'ipc_error' }
  }
  if (!info) {
    return { ok: false, reason: 'port_file_missing' }
  }

  // 1) Running? — unauthenticated healthz. Connection-refused / non-2xx => not running.
  try {
    const resp = await fetch(`${info.base_url}/v1/healthz`)
    if (!resp.ok) {
      console.warn('[daemon-local-client] healthz returned', resp.status)
      return { ok: false, reason: 'not_running' }
    }
  } catch (err) {
    console.warn('[daemon-local-client] healthz unreachable (daemon down?):', err)
    return { ok: false, reason: 'not_running' }
  }

  // 2) Token valid? — exchange the root token for a scoped session token.
  invalidateDaemonConnection()
  _connection = null
  const conn = await _fetchConnection()
  if (!conn) return { ok: false, reason: 'token_invalid' }

  return { ok: true, baseUrl: conn.baseUrl }
}

/** True when the local daemon HTTP server responds to `/v1/healthz`. */
export async function isDaemonHttpAvailable(): Promise<boolean> {
  const probe = await probeDaemonHttp()
  return probe.ok
}

// 'ok'      — daemon's cloud session refreshes normally.
// 'expired' — refresh token terminally rejected (re-onboarding required).
// 'unknown' — daemon unreachable, or an older daemon that doesn't report it.
export type DaemonCloudAuthStatus = 'ok' | 'expired' | 'unknown'

/**
 * Read the local daemon's cloud-auth session health from `/v1/info` (an
 * unauthenticated endpoint). `'expired'` means the stored refresh token was
 * terminally rejected by the auth backend — the daemon keeps retrying a dead
 * token and the desktop should re-onboard it. Best-effort: any reachability or
 * shape problem degrades to `'unknown'` (never throws).
 */
export async function fetchDaemonCloudAuthStatus(): Promise<DaemonCloudAuthStatus> {
  if (!isTauri()) return 'unknown'
  const info = await readDaemonHttpInfo()
  if (!info) return 'unknown'
  try {
    const resp = await fetch(`${info.base_url}/v1/info`)
    if (!resp.ok) return 'unknown'
    const data: { cloud_auth?: { status?: string } } = await resp.json()
    const status = data.cloud_auth?.status
    if (status === 'expired') return 'expired'
    if (status === 'ok') return 'ok'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// ─── Authenticated fetch ──────────────────────────────────────────────────────

async function daemonFetch<T>(
  path: string,
  init?: RequestInit,
  // Internal: set false to disable the single reconnect retry (prevents loops).
  allowRetry = true,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const conn = await getConnection()
  if (!conn) {
    return {
      ok: false,
      status: 0,
      error: 'amuxd daemon is not connected. Restart TeamClaw or confirm amuxd is running.',
    }
  }

  let resp: Response
  try {
    resp = await fetch(`${conn.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${conn.sessionToken}`,
        ...(init?.headers ?? {}),
      },
    })
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    if (allowRetry) {
      invalidateDaemonConnection()
      return daemonFetch<T>(path, init, false)
    }
    return {
      ok: false,
      status: 0,
      error: formatFetchNetworkError(conn.baseUrl, raw),
    }
  }

  if (!resp.ok) {
    // A 401 means our cached session token was rejected — most commonly because
    // the daemon restarted and minted a new root token. Drop the stale token,
    // re-exchange, and retry the request exactly once.
    if (resp.status === 401 && allowRetry) {
      invalidateDaemonConnection()
      return daemonFetch<T>(path, init, false)
    }
    const text = await resp.text().catch(() => '')
    return { ok: false, status: resp.status, error: text }
  }

  const data: T = await resp.json()
  return { ok: true, data }
}

async function daemonFetchData<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await daemonFetch<T>(path, init)
  if (!result.ok) throw new Error(result.error)
  return result.data
}

// ─── Local agent runtime (`agents.local_agent` in daemon.toml) ────────────────

/** The local agent runtimes the daemon can drive. */
export type DaemonLocalAgent = 'opencode' | 'pi'

interface DaemonConfigEntry {
  key: string
  value: unknown
  display: string
  secret: boolean
}

/**
 * Read the daemon's configured local agent runtime. An unset key (older
 * daemon.toml with no `agents.local_agent`) means the "opencode" default.
 */
export async function getDaemonLocalAgent(): Promise<DaemonLocalAgent> {
  const result = await daemonFetch<DaemonConfigEntry>('/v1/config/agents.local_agent')
  if (!result.ok) {
    // 404 = key absent → daemon default. Anything else: fall back conservatively.
    return 'opencode'
  }
  return result.data.value === 'pi' ? 'pi' : 'opencode'
}

/**
 * Switch the daemon's local agent runtime. Writes `agents.local_agent`; the
 * caller must restart the daemon (this key is restart-required) for the new
 * backend to take effect. Returns whether a restart is required (always true
 * for this key, surfaced for symmetry with the daemon response).
 */
export async function setDaemonLocalAgent(agent: DaemonLocalAgent): Promise<{ requiresRestart: boolean }> {
  const result = await daemonFetch<{ requiresRestart: boolean }>('/v1/config/agents.local_agent', {
    method: 'PUT',
    body: JSON.stringify({ value: agent }),
  })
  if (!result.ok) throw new Error(result.error || 'failed to set local agent')
  return { requiresRestart: result.data.requiresRestart ?? true }
}

// ─── Workspace-control types (mirrors Rust workspace_control.rs) ──────────────

export interface DaemonProviderInfo {
  id: string
  display_name: string
  authenticated: boolean
  base_url?: string
  models: string[]
}

export interface DaemonProviderAuthRequest {
  api_key: string
  base_url?: string
  display_name?: string
  models?: Array<{ model_id: string; model_name?: string }>
}

/** Skill-name → 'allow' | 'deny' | 'ask' */
export type DaemonPermissionMap = Record<string, 'allow' | 'deny' | 'ask'>

export interface DaemonPermissionConfig {
  skills: DaemonPermissionMap
  tools: DaemonPermissionMap
}

export interface DaemonAllowlistRule {
  project_id: string
  permission: string
  pattern: string
  decision: 'allow' | 'deny'
}

export type DaemonApplyOutcome = 'applied_live' | 'reload_required' | 'restart_required'

// ─── Providers ────────────────────────────────────────────────────────────────

export async function getDaemonProviders(
  workspaceId: string,
): Promise<DaemonProviderInfo[] | null> {
  const result = await daemonFetch<DaemonProviderInfo[]>(
    `/v1/workspaces/${workspaceId}/providers`,
  )
  return result.ok ? result.data : null
}

// ─── Provider auth catalog & OAuth (Phase 1 catalog, Phase 2 execution) ─────

export type DaemonProviderAuthMethod = {
  type: 'oauth' | 'api'
  label: string
}

export type DaemonProviderAuthMethods = Record<string, DaemonProviderAuthMethod[]>

export async function getDaemonProviderAuthMethods(
  workspaceId: string,
): Promise<DaemonProviderAuthMethods | null> {
  const result = await daemonFetch<DaemonProviderAuthMethods>(
    `/v1/workspaces/${workspaceId}/provider-auth-methods`,
  )
  return result.ok ? result.data : null
}

export type DaemonOAuthAuthorizeResult =
  | { ok: true; url: string; method: 'auto' | 'code'; instructions: string }
  | { ok: false; status: number; code?: string; message: string }

export type DaemonOAuthCallbackResult =
  | { ok: true; outcome: DaemonApplyOutcome }
  | { ok: false; status: number; code?: string; message: string }

function problemDetailFromErrorBody(error: string): { code?: string; detail: string } {
  try {
    const parsed = JSON.parse(error) as { code?: string; detail?: string }
    return {
      code: parsed.code,
      detail: parsed.detail ?? error,
    }
  } catch {
    return { detail: error }
  }
}

export async function postDaemonProviderOAuthAuthorize(
  workspaceId: string,
  providerId: string,
  methodIndex: number,
  inputs?: Record<string, string>,
): Promise<DaemonOAuthAuthorizeResult> {
  const result = await daemonFetch<{
    url: string
    method: string
    instructions: string
  }>(
    `/v1/workspaces/${workspaceId}/providers/${encodeURIComponent(providerId)}/oauth/authorize`,
    {
      method: 'POST',
      body: JSON.stringify({ method_index: methodIndex, inputs: inputs ?? {} }),
    },
  )
  if (result.ok) {
    const method =
      result.data.method === 'auto' || result.data.method === 'code'
        ? result.data.method
        : 'code'
    return {
      ok: true,
      url: result.data.url,
      method,
      instructions: result.data.instructions,
    }
  }
  const problem = problemDetailFromErrorBody(result.error)
  return {
    ok: false,
    status: result.status,
    code: problem.code,
    message: problem.detail,
  }
}

export async function postDaemonProviderOAuthCallback(
  workspaceId: string,
  providerId: string,
  methodIndex: number,
  code?: string,
): Promise<DaemonOAuthCallbackResult> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/providers/${encodeURIComponent(providerId)}/oauth/callback`,
    {
      method: 'POST',
      body: JSON.stringify({ method_index: methodIndex, code: code ?? null }),
    },
  )
  if (result.ok) {
    return { ok: true, outcome: result.data.outcome }
  }
  const problem = problemDetailFromErrorBody(result.error)
  return {
    ok: false,
    status: result.status,
    code: problem.code,
    message: problem.detail,
  }
}

/** Mirrors Rust `workspaces::CatalogModel`. `ref` is `"<providerSegment>/<modelId>"`. */
export interface DaemonCatalogModel {
  ref: string
  model_id: string
  display_name: string
}

/** Mirrors Rust `workspaces::BackendCatalog`. `backend` is "opencode" | "claude" | "codex". */
export interface DaemonBackendCatalog {
  backend: string
  label: string
  models: DaemonCatalogModel[]
}

/** Mirrors Rust `workspaces::ModelCatalog`. */
export interface DaemonModelCatalog {
  automation_default_backend: string | null
  backends: DaemonBackendCatalog[]
}

/**
 * `GET /v1/workspaces/:id/model-catalog` — models grouped by the agent backend
 * that would run them (OpenCode, Claude Code, Codex). Source of truth for the
 * cron dialog, replacing the OpenCode-only provider list.
 */
export async function getDaemonModelCatalog(
  workspaceId: string,
): Promise<DaemonModelCatalog | null> {
  const result = await daemonFetch<DaemonModelCatalog>(
    `/v1/workspaces/${workspaceId}/model-catalog`,
  )
  return result.ok ? result.data : null
}

export async function putDaemonProviderAuth(
  workspaceId: string,
  providerId: string,
  req: DaemonProviderAuthRequest,
): Promise<DaemonApplyOutcome> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/providers/${encodeURIComponent(providerId)}/auth`,
    { method: 'POST', body: JSON.stringify(req) },
  )
  if (!result.ok) {
    const { detail } = problemDetailFromErrorBody(result.error)
    throw new Error(detail || `Failed to save provider auth (${result.status})`)
  }
  return result.data.outcome
}

export async function deleteDaemonProviderAuth(
  workspaceId: string,
  providerId: string,
): Promise<DaemonApplyOutcome | null> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/providers/${encodeURIComponent(providerId)}/auth`,
    { method: 'DELETE' },
  )
  return result.ok ? result.data.outcome : null
}

// ─── Permissions ──────────────────────────────────────────────────────────────

/**
 * Fetch the full workspace permission config (skill + tool defaults).
 */
export async function getDaemonPermissionConfig(
  workspaceId: string,
): Promise<DaemonPermissionConfig | null> {
  const result = await daemonFetch<DaemonPermissionConfig>(
    `/v1/workspaces/${workspaceId}/permissions`,
  )
  if (!result.ok) return null
  return {
    skills: result.data.skills ?? {},
    tools: result.data.tools ?? {},
  }
}

/**
 * Fetch the workspace permission map.
 * Returns a flat `{ bash: 'ask', read: 'allow', ... }` object for skill keys only.
 */
export async function getDaemonPermissions(
  workspaceId: string,
): Promise<DaemonPermissionMap | null> {
  const config = await getDaemonPermissionConfig(workspaceId)
  return config?.skills ?? null
}

/** Tool-level permission defaults (e.g. `bash`, `read`) outside the skill map. */
export async function getDaemonToolPermissions(
  workspaceId: string,
): Promise<DaemonPermissionMap | null> {
  const config = await getDaemonPermissionConfig(workspaceId)
  return config?.tools ?? null
}

/**
 * Replace the workspace skill permission map.
 * Pass `tools` to merge tool-level defaults; omitted/empty tools are left unchanged.
 */
export async function putDaemonPermissions(
  workspaceId: string,
  permissions: DaemonPermissionMap,
  tools?: DaemonPermissionMap,
): Promise<DaemonApplyOutcome | null> {
  const body: DaemonPermissionConfig = { skills: permissions, tools: tools ?? {} }
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/permissions`,
    { method: 'PUT', body: JSON.stringify(body) },
  )
  return result.ok ? result.data.outcome : null
}

/** Merge tool-level permission defaults without replacing skill permissions. */
export async function putDaemonToolPermissions(
  workspaceId: string,
  tools: DaemonPermissionMap,
): Promise<DaemonApplyOutcome | null> {
  return putDaemonPermissions(workspaceId, {}, tools)
}

// ─── Roles & skills ───────────────────────────────────────────────────────────

/** Mirrors `RolesSkillsWorkspaceState` from lib/roles/types.ts (camelCase from daemon). */
export interface DaemonRolesSkillsState {
  roles: Array<{
    slug: string
    name: string
    description: string
    body: string
    role: string
    whenToUse: string
    workingStyle: string
    roleSkills: Array<{ name: string; description: string }>
    filePath: string
    rawMarkdown: string
  }>
  skills: Array<{
    filename: string
    name: string
    invocationName?: string
    content: string
    description: string
    source?: string
    dirPath: string
    linkedRoles: string[]
    isRoleSkill: boolean
  }>
  roleUsageBySkill: Record<string, string[]>
  skillNamesByRole: Record<string, string[]>
  metrics: {
    rolesCount: number
    skillsCount: number
    linkedSkillsCount: number
    unlinkedSkillsCount: number
  }
}

export async function getDaemonRolesSkillsState(
  workspaceId: string,
): Promise<DaemonRolesSkillsState | null> {
  const result = await daemonFetch<DaemonRolesSkillsState>(
    `/v1/workspaces/${workspaceId}/roles-skills`,
  )
  return result.ok ? result.data : null
}

export async function getDaemonSkills(
  workspaceId: string,
): Promise<DaemonRolesSkillsState['skills'] | null> {
  const result = await daemonFetch<DaemonRolesSkillsState['skills']>(
    `/v1/workspaces/${workspaceId}/skills`,
  )
  return result.ok ? result.data : null
}

export async function getDaemonRoles(
  workspaceId: string,
): Promise<DaemonRolesSkillsState['roles'] | null> {
  const result = await daemonFetch<DaemonRolesSkillsState['roles']>(
    `/v1/workspaces/${workspaceId}/roles`,
  )
  return result.ok ? result.data : null
}

export interface DaemonUpsertSkillRequest {
  content: string
  skillName?: string
  installLocation?: 'workspace' | 'global'
  dirPath?: string
  filename?: string
}

export async function putDaemonSkill(
  workspaceId: string,
  slug: string,
  req: DaemonUpsertSkillRequest,
): Promise<DaemonRolesSkillsState['skills'][number] | null> {
  const result = await daemonFetch<DaemonRolesSkillsState['skills'][number]>(
    `/v1/workspaces/${workspaceId}/skills/${encodeURIComponent(slug)}`,
    { method: 'PUT', body: JSON.stringify(req) },
  )
  return result.ok ? result.data : null
}

export async function deleteDaemonSkill(
  workspaceId: string,
  slug: string,
  dirPath?: string,
): Promise<DaemonApplyOutcome | null> {
  const query = dirPath ? `?dirPath=${encodeURIComponent(dirPath)}` : ''
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/skills/${encodeURIComponent(slug)}${query}`,
    { method: 'DELETE' },
  )
  return result.ok ? result.data.outcome : null
}

export interface DaemonUpsertRoleRequest {
  rawMarkdown: string
  targetFilePath?: string
}

export async function putDaemonRole(
  workspaceId: string,
  slug: string,
  req: DaemonUpsertRoleRequest,
): Promise<DaemonRolesSkillsState['roles'][number] | null> {
  const result = await daemonFetch<DaemonRolesSkillsState['roles'][number]>(
    `/v1/workspaces/${workspaceId}/roles/${encodeURIComponent(slug)}`,
    { method: 'PUT', body: JSON.stringify(req) },
  )
  return result.ok ? result.data : null
}

export async function deleteDaemonRole(
  workspaceId: string,
  slug: string,
  filePath?: string,
): Promise<DaemonApplyOutcome | null> {
  const query = filePath ? `?filePath=${encodeURIComponent(filePath)}` : ''
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/roles/${encodeURIComponent(slug)}${query}`,
    { method: 'DELETE' },
  )
  return result.ok ? result.data.outcome : null
}

// ─── Allowlist ────────────────────────────────────────────────────────────────

export async function getDaemonAllowlist(
  workspaceId: string,
): Promise<DaemonAllowlistRule[] | null> {
  const result = await daemonFetch<DaemonAllowlistRule[]>(
    `/v1/workspaces/${workspaceId}/permission-allowlist`,
  )
  return result.ok ? result.data : null
}

export async function putDaemonAllowlist(
  workspaceId: string,
  rules: DaemonAllowlistRule[],
): Promise<DaemonApplyOutcome | null> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/permission-allowlist`,
    { method: 'PUT', body: JSON.stringify(rules) },
  )
  return result.ok ? result.data.outcome : null
}

// ─── Apps ─────────────────────────────────────────────────────────────────────

/**
 * Kick the local daemon to seed a freshly-created app repo (clone the empty
 * managed-git repo, write the starter template, first commit + push).
 *
 * Best-effort and **non-fatal**: app creation must succeed even when the daemon
 * is down or the push fails. We pass only `{ appId, gitRemoteUrl }` — no
 * `workdir` (the daemon resolves `<amuxd home>/apps/<appId>` itself) and no git
 * credential. Credentialed pushes to *private* per-app repos are out of scope
 * for phase 1 (needs a per-app secret-delivery channel); for those the seed
 * fails daemon-side and is logged here, which is expected.
 *
 * Returns a three-state outcome (never throws):
 * - `"seeded"`    — the daemon accepted and completed the seed.
 * - `"failed"`    — the daemon was reachable but the seed failed (terminal).
 * - `"unreachable"` — the daemon is down/unreachable (status 0 or thrown);
 *   the caller should leave the app row untouched so a reseed stays available.
 */
export type SeedAppOutcome = "seeded" | "failed" | "unreachable";

export async function seedDaemonApp(
  appId: string,
  gitRemoteUrl: string,
  teamId: string,
): Promise<SeedAppOutcome> {
  try {
    const result = await daemonFetch<{ status: string }>('/v1/apps/seed', {
      method: 'POST',
      body: JSON.stringify({ appId, gitRemoteUrl, teamId }),
    })
    if (result.ok) return "seeded"
    if (result.status === 0) {
      console.warn('[daemon-local-client] app seed unreachable (non-fatal):', result.error)
      return "unreachable"
    }
    console.warn('[daemon-local-client] app seed failed (non-fatal):', result.error)
    return "failed"
  } catch (err) {
    console.warn('[daemon-local-client] app seed unavailable (non-fatal):', err)
    return "unreachable"
  }
}

/**
 * Kick the local daemon to build an app's artifact and upload it to OSS via the
 * presigned PUT URL minted by the cloud `deploy` call. The daemon runs the build
 * in `<amuxd home>/apps/<appId>` (it must already be seeded) and PUTs the zip.
 *
 * Three-state outcome (never throws), mirroring {@link seedDaemonApp}:
 * - `"built"`       — the daemon built + uploaded successfully.
 * - `"failed"`      — daemon reachable but the build/upload failed (terminal).
 * - `"unreachable"` — daemon down/unreachable; the caller should not finalize.
 */
export type BuildAppOutcome = "built" | "failed" | "unreachable";

export async function buildDaemonApp(
  appId: string,
  teamId: string,
  presignedPut: string,
): Promise<BuildAppOutcome> {
  try {
    const result = await daemonFetch<{ status: string }>('/v1/apps/build', {
      method: 'POST',
      body: JSON.stringify({ appId, teamId, presignedPut }),
    })
    if (result.ok) return "built"
    if (result.status === 0) {
      console.warn('[daemon-local-client] app build unreachable (non-fatal):', result.error)
      return "unreachable"
    }
    console.warn('[daemon-local-client] app build failed:', result.error)
    return "failed"
  } catch (err) {
    console.warn('[daemon-local-client] app build unavailable:', err)
    return "unreachable"
  }
}

// ─── MCP ──────────────────────────────────────────────────────────────────────

/** Single MCP server config entry; mirrors `McpServerConfig` in workspace_control.rs. */
export interface DaemonMcpServerConfig {
  /** `"local"` (stdio) or `"remote"` (HTTP). May be absent for legacy entries. */
  type?: string
  /** Provenance from daemon merge: workspace custom, team shared, or built-in. */
  source?: 'workspace' | 'team' | 'inherent'
  enabled?: boolean
  /** Command + args for local stdio servers. */
  command?: string[]
  environment?: Record<string, string>
  /** Base URL for remote HTTP servers. */
  url?: string
  headers?: Record<string, string>
  timeout?: number
  [key: string]: unknown
}

export async function getDaemonMcp(
  workspaceId: string,
): Promise<Record<string, DaemonMcpServerConfig>> {
  return daemonFetchData<Record<string, DaemonMcpServerConfig>>(
    `/v1/workspaces/${workspaceId}/mcp`,
  )
}

export async function putDaemonMcp(
  workspaceId: string,
  servers: Record<string, DaemonMcpServerConfig>,
): Promise<DaemonApplyOutcome> {
  const data = await daemonFetchData<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/mcp`,
    { method: 'PUT', body: JSON.stringify(servers) },
  )
  return data.outcome
}

export interface DaemonMcpServerProbeResult {
  probe_status: 'skipped' | 'ready' | 'failed'
  tools: string[]
  error: string | null
  probed_at: string | null
}

export async function getDaemonMcpTools(
  workspaceId: string,
  options?: { refresh?: boolean },
): Promise<Record<string, DaemonMcpServerProbeResult>> {
  const query = options?.refresh ? '?refresh=1' : ''
  const data = await daemonFetchData<{ servers: Record<string, DaemonMcpServerProbeResult> }>(
    `/v1/workspaces/${workspaceId}/mcp/tools${query}`,
  )
  return data.servers
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export type DaemonRuntimeRefreshStatus = 'clean' | 'pending' | 'applying' | 'failed'

export interface DaemonRuntimeRefresh {
  status: DaemonRuntimeRefreshStatus
  change_kinds: string[]
  recommended_action: 'none' | 'apply_changes'
  auto_apply_blocked_by_active_runtime: boolean
  last_detected_at: string | null
  last_error: string | null
}

export interface DaemonRuntimeStatus {
  workspace_id: string
  ready: boolean
  backend: string
  current_model: string | null
  refresh: DaemonRuntimeRefresh
}

export async function getDaemonRuntime(
  workspaceId: string,
): Promise<DaemonRuntimeStatus | null> {
  const result = await daemonFetch<DaemonRuntimeStatus>(
    `/v1/workspaces/${workspaceId}/runtime`,
  )
  return result.ok ? result.data : null
}

export async function reloadDaemonRuntime(
  workspaceId: string,
): Promise<DaemonApplyOutcome | null> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/runtime/reload`,
    { method: 'POST' },
  )
  return result.ok ? result.data.outcome : null
}

// ─── Team share ───────────────────────────────────────────────────────────────

export interface DaemonTeamLinkResult {
  team_id: string
  /** `symlink` | `junction` | `fallback` | `legacy_retained` */
  status: 'symlink' | 'junction' | 'fallback' | 'legacy_retained'
  /** `~/.amuxd/teams/<team_id>/teamclaw-team` */
  global_dir: string
}

/**
 * Ask the local daemon to materialize the team's global dir + this workspace's
 * `teamclaw-team` symlink *now* — called right after enabling/joining
 * team-share so the synced directory exists immediately instead of waiting for
 * the daemon's next start or the first runtime (the AddWorkspace path rides
 * MQTT, which may not be connected right after onboarding).
 *
 * Best-effort: returns `null` when the daemon HTTP is unavailable or the call
 * fails (e.g. the daemon isn't onboarded to a team). The link is still created
 * lazily later, so a failure here is non-fatal to enabling team-share.
 */
export async function linkDaemonTeamWorkspace(
  workspacePath: string,
  options?: { strict?: boolean },
): Promise<DaemonTeamLinkResult | null> {
  const path = workspacePath.trim()
  if (!path) {
    if (options?.strict) throw new Error('workspace path is required to link team directory')
    return null
  }
  try {
    const result = await daemonFetch<DaemonTeamLinkResult>('/v1/team/link', {
      method: 'POST',
      body: JSON.stringify({ path }),
    })
    if (!result.ok) {
      const msg = result.error ?? 'daemon team link failed'
      if (options?.strict) throw new Error(msg)
      console.warn('[daemon-local-client] team link failed:', msg)
      return null
    }
    return result.data
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (options?.strict) throw new Error(msg, { cause: err })
    // Network/IPC errors (daemon not running, no HTTP) are expected and
    // non-fatal — the link is created lazily on the daemon's next start.
    console.warn('[daemon-local-client] team link unavailable:', msg)
    return null
  }
}
