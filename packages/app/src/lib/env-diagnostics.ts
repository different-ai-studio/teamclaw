import type {
  DaemonEnvActivationDiagnostics,
  DaemonRuntimeRefresh,
} from '@/lib/daemon-local-client'
import type { TFunction } from 'i18next'

/** Personal env storage diagnostics from the desktop Tauri command. */
export interface PersonalEnvDiagnostics {
  storageDir: string
  secretsDir: string
  masterKeyExists: boolean
  blobExists: boolean
  blobReadable: boolean
  blobError: string | null
  storedVarCount: number
  userStoredVarCount: number
  workspaceIndexCount: number
  indexKeysMissingFromBlob: string[]
  blobKeysMissingFromIndex: string[]
  hostShadowedKeys: string[]
}

const EMPTY_REFRESH: DaemonRuntimeRefresh = {
  status: 'clean',
  change_kinds: [],
  recommended_action: 'none',
  auto_apply_blocked_by_active_runtime: false,
  last_detected_at: null,
  last_error: null,
}

export interface EnvActivationBlocker {
  code: string
  detail?: string | null
}

/** Translate daemon blocker codes for the settings diagnostics UI. */
export function formatEnvActivationBlocker(
  t: TFunction,
  blocker: EnvActivationBlocker,
): string {
  const detail = blocker.detail?.trim()
  const detailSuffix = detail ? `: ${detail}` : ''
  switch (blocker.code) {
    case 'personal_blob_undecryptable':
      return t('settings.envVars.diag.blockerPersonalBlobUndecryptable', {
        detail: detailSuffix,
        defaultValue: `Personal secrets blob exists but cannot be decrypted${detailSuffix}`,
      })
    case 'personal_blob_missing':
      return t('settings.envVars.diag.blockerPersonalBlobMissing', 'Master key exists but the encrypted blob is missing')
    case 'personal_store_uninitialized':
      return t('settings.envVars.diag.blockerPersonalStoreUninitialized', 'Personal secrets store is not initialized on this machine')
    case 'refresh_failed':
      return t('settings.envVars.diag.blockerRefreshFailed', {
        detail: detailSuffix,
        defaultValue: `Runtime refresh failed${detailSuffix}`,
      })
    case 'env_vars_pending':
      return t('settings.envVars.diag.blockerEnvVarsPending', 'Env var changes are pending — reload the workspace runtime')
    case 'refresh_deferred_active_turn':
      return t('settings.envVars.diag.blockerRefreshDeferredActiveTurn', 'Refresh deferred while a turn is in progress — retry after it finishes or reload manually')
    case 'active_runtimes':
      return t('settings.envVars.diag.blockerActiveRuntimes', {
        count: detail ?? '?',
        defaultValue: `${detail ?? '?'} active runtime(s) in this workspace — env is injected at spawn; start a new session after reload`,
      })
    case 'turn_in_progress':
      return t('settings.envVars.diag.blockerTurnInProgress', 'A turn is currently running — wait for it to finish, then reload runtime')
    case 'opencode_serve_no_cached_env':
      return t('settings.envVars.diag.blockerOpencodeServeNoCachedEnv', 'opencode serve is running but has no cached session env — reload runtime so the next spawn merges personal vars')
    case 'host_env_shadowed':
      return t('settings.envVars.diag.blockerHostEnvShadowed', {
        keys: detail ?? '',
        defaultValue: `Host OS environment overrides personal vars for: ${detail ?? ''}`,
      })
    default:
      if (blocker.code === 'legacy_message' && detail) return detail
      return detail ? `${blocker.code}: ${detail}` : blocker.code
  }
}

function normalizeBlocker(raw: Partial<EnvActivationBlocker>): EnvActivationBlocker {
  return {
    code: raw.code ?? 'unknown',
    detail: raw.detail ?? null,
  }
}

/** Coerce partial / older daemon responses so UI never crashes on missing fields. */
export function normalizeDaemonEnvActivationDiagnostics(
  raw: Partial<DaemonEnvActivationDiagnostics> | null | undefined,
): DaemonEnvActivationDiagnostics | null {
  if (!raw) return null

  const blockers = (raw.blockers ?? []).map((entry) => {
    if (typeof entry === 'string') {
      return { code: 'legacy_message', detail: entry }
    }
    return normalizeBlocker(entry)
  })

  return {
    personal_env_var_count: raw.personal_env_var_count ?? raw.personal_blob_user_var_count ?? 0,
    personal_blob_user_var_count: raw.personal_blob_user_var_count ?? raw.personal_env_var_count ?? 0,
    personal_blob_readable: raw.personal_blob_readable ?? false,
    personal_load_error: raw.personal_load_error ?? null,
    team_env_var_count: raw.team_env_var_count ?? 0,
    opencode_serve_running: raw.opencode_serve_running ?? false,
    opencode_serve_cached_env_count: raw.opencode_serve_cached_env_count ?? 0,
    active_runtime_count: raw.active_runtime_count ?? 0,
    workspace_has_active_turn: raw.workspace_has_active_turn ?? false,
    refresh: {
      ...EMPTY_REFRESH,
      ...raw.refresh,
      change_kinds: raw.refresh?.change_kinds ?? [],
    },
    host_env_shadowed_keys: raw.host_env_shadowed_keys ?? [],
    blockers,
  }
}

/** Coerce partial / older desktop responses so UI never crashes on missing fields. */
export function normalizePersonalEnvDiagnostics(
  raw: Partial<PersonalEnvDiagnostics> | null | undefined,
): PersonalEnvDiagnostics | null {
  if (!raw) return null
  return {
    storageDir: raw.storageDir ?? '',
    secretsDir: raw.secretsDir ?? '',
    masterKeyExists: raw.masterKeyExists ?? false,
    blobExists: raw.blobExists ?? false,
    blobReadable: raw.blobReadable ?? false,
    blobError: raw.blobError ?? null,
    storedVarCount: raw.storedVarCount ?? 0,
    userStoredVarCount: raw.userStoredVarCount ?? raw.storedVarCount ?? 0,
    workspaceIndexCount: raw.workspaceIndexCount ?? 0,
    indexKeysMissingFromBlob: raw.indexKeysMissingFromBlob ?? [],
    blobKeysMissingFromIndex: raw.blobKeysMissingFromIndex ?? [],
    hostShadowedKeys: raw.hostShadowedKeys ?? [],
  }
}
