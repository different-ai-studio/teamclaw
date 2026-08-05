import { describe, expect, it } from 'vitest'
import {
  computeEnvActivationOverallStatus,
  normalizeDaemonEnvActivationDiagnostics,
  normalizePersonalEnvDiagnostics,
} from '../env-diagnostics'
import type { DaemonEnvActivationDiagnostics } from '@/lib/daemon-local-client'

const basePersonal = {
  storageDir: '',
  secretsDir: '',
  masterKeyExists: true,
  blobExists: true,
  blobReadable: true,
  blobError: null,
  storedVarCount: 1,
  userStoredVarCount: 1,
  workspaceIndexCount: 1,
  indexKeysMissingFromBlob: [] as string[],
  blobKeysMissingFromIndex: [] as string[],
  hostShadowedKeys: [] as string[],
}

const baseActivation: DaemonEnvActivationDiagnostics = {
  personal_env_var_count: 1,
  personal_blob_user_var_count: 1,
  personal_blob_readable: true,
  personal_load_error: null,
  team_env_var_count: 0,
  system_env_var_count: 1,
  opencode_serve_running: true,
  opencode_serve_cached_env_count: 3,
  active_runtime_count: 0,
  workspace_has_active_turn: false,
  refresh: {
    status: 'clean',
    change_kinds: [],
    recommended_action: 'none',
    auto_apply_blocked_by_active_runtime: false,
    last_detected_at: null,
    last_error: null,
  },
  host_env_shadowed_keys: [],
  resolved_env_fingerprint: 'abc',
  active_env_fingerprint: 'abc',
  override_keys: [],
  alias_collision_keys: [],
  unresolved_env_keys: [],
  snapshot_conflict_workspace: null,
  activation_status: 'active',
  blockers: [],
  expected_env_keys: ['openai_api_key'],
  effective_env_keys: ['openai_api_key'],
  missing_expected_keys: [],
  key_statuses: [{ key: 'openai_api_key', scope: 'personal', status: 'active' }],
  mcp_unresolved_placeholders: [],
  installed_env_fingerprint: 'abc',
  active_handle_env_fingerprint: 'abc',
  team_secret_configured: true,
  opencode_serve_cached_env_keys: ['openai_api_key'],
  missing_served_env_keys: [],
  active_handle_env_keys: ['openai_api_key'],
}

describe('computeEnvActivationOverallStatus', () => {
  it('returns healthy when storage, refresh, and snapshot all align', () => {
    expect(computeEnvActivationOverallStatus(basePersonal, baseActivation, 0)).toBe('healthy')
  })

  it('returns blocked when personal blob is unreadable', () => {
    expect(
      computeEnvActivationOverallStatus(
        { ...basePersonal, blobReadable: false },
        baseActivation,
        0,
      ),
    ).toBe('blocked')
  })

  it('returns degraded when active runtimes exist', () => {
    expect(
      computeEnvActivationOverallStatus(
        basePersonal,
        { ...baseActivation, active_runtime_count: 2, blockers: [{ code: 'active_runtimes', detail: '2' }] },
        0,
      ),
    ).toBe('degraded')
  })

  it('returns blocked when env_not_served blocker is present', () => {
    expect(
      computeEnvActivationOverallStatus(
        basePersonal,
        {
          ...baseActivation,
          missing_served_env_keys: ['openai_api_key'],
          blockers: [{ code: 'env_not_served', detail: 'openai_api_key' }],
        },
        0,
      ),
    ).toBe('blocked')
  })

  it('returns blocked when unresolved env keys are present', () => {
    expect(
      computeEnvActivationOverallStatus(
        basePersonal,
        {
          ...baseActivation,
          unresolved_env_keys: ['team_token'],
          blockers: [{ code: 'unresolved_env_keys', detail: 'team_token' }],
        },
        0,
      ),
    ).toBe('blocked')
  })
})

describe('normalizeDaemonEnvActivationDiagnostics', () => {
  it('fills missing host_env_shadowed_keys and blockers', () => {
    const normalized = normalizeDaemonEnvActivationDiagnostics({
      personal_env_var_count: 2,
      personal_blob_readable: true,
    })
    expect(normalized?.host_env_shadowed_keys).toEqual([])
    expect(normalized?.override_keys).toEqual([])
    expect(normalized?.activation_status).toBe('pending')
    expect(normalized?.blockers).toEqual([])
    expect(normalized?.refresh.change_kinds).toEqual([])
  })

  it('normalizes legacy string blockers', () => {
    const normalized = normalizeDaemonEnvActivationDiagnostics({
      blockers: ['old message'] as unknown as DaemonEnvActivationDiagnostics['blockers'],
    })
    expect(normalized?.blockers).toEqual([{ code: 'legacy_message', detail: 'old message' }])
  })

  it('accepts the daemon camelCase wire shape', () => {
    const normalized = normalizeDaemonEnvActivationDiagnostics({
      personalEnvVarCount: 3,
      systemEnvVarCount: 4,
      resolvedEnvFingerprint: 'resolved-hash',
      activeEnvFingerprint: 'active-hash',
      overrideKeys: ['API_KEY'],
      activationStatus: 'blocked',
    } as unknown as Partial<DaemonEnvActivationDiagnostics>)

    expect(normalized).toMatchObject({
      personal_env_var_count: 3,
      system_env_var_count: 4,
      resolved_env_fingerprint: 'resolved-hash',
      active_env_fingerprint: 'active-hash',
      override_keys: ['API_KEY'],
      activation_status: 'blocked',
    })
  })

  it('returns null for null input', () => {
    expect(normalizeDaemonEnvActivationDiagnostics(null)).toBeNull()
  })
})

describe('normalizePersonalEnvDiagnostics', () => {
  it('fills missing hostShadowedKeys', () => {
    const normalized = normalizePersonalEnvDiagnostics({
      storageDir: 'teamclaw',
      blobReadable: true,
    })
    expect(normalized?.hostShadowedKeys).toEqual([])
    expect(normalized?.indexKeysMissingFromBlob).toEqual([])
  })
})
