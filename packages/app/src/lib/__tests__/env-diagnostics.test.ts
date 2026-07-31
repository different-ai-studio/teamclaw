import { describe, expect, it } from 'vitest'
import {
  normalizeDaemonEnvActivationDiagnostics,
  normalizePersonalEnvDiagnostics,
} from '../env-diagnostics'
import type { DaemonEnvActivationDiagnostics } from '@/lib/daemon-local-client'

describe('normalizeDaemonEnvActivationDiagnostics', () => {
  it('fills missing host_env_shadowed_keys and blockers', () => {
    const normalized = normalizeDaemonEnvActivationDiagnostics({
      personal_env_var_count: 2,
      personal_blob_readable: true,
    })
    expect(normalized?.host_env_shadowed_keys).toEqual([])
    expect(normalized?.blockers).toEqual([])
    expect(normalized?.refresh.change_kinds).toEqual([])
  })

  it('normalizes legacy string blockers', () => {
    const normalized = normalizeDaemonEnvActivationDiagnostics({
      blockers: ['old message'] as unknown as DaemonEnvActivationDiagnostics['blockers'],
    })
    expect(normalized?.blockers).toEqual([{ code: 'legacy_message', detail: 'old message' }])
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
