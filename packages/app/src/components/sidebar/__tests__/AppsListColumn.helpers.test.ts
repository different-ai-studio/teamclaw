import { describe, test, expect } from 'vitest'
import { pickMostRecentSession, canReseed, appStatusMeta } from '../AppsListColumn'
import type { AppSessionRow } from '@/lib/backend/types'

function row(p: Partial<AppSessionRow>): AppSessionRow {
  return {
    id: 'id',
    teamId: 't',
    title: 'title',
    mode: 'collab',
    lastMessageAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...p,
  }
}

describe('pickMostRecentSession', () => {
  test('returns null for empty list', () => {
    expect(pickMostRecentSession([])).toBeNull()
  })

  test('picks the row with the latest lastMessageAt', () => {
    const rows = [
      row({ id: 'a', lastMessageAt: '2026-06-01T00:00:00.000Z' }),
      row({ id: 'b', lastMessageAt: '2026-06-10T00:00:00.000Z' }),
      row({ id: 'c', lastMessageAt: '2026-06-05T00:00:00.000Z' }),
    ]
    expect(pickMostRecentSession(rows)?.id).toBe('b')
  })

  test('falls back to createdAt when lastMessageAt is null', () => {
    const rows = [
      row({ id: 'a', lastMessageAt: null, createdAt: '2026-06-01T00:00:00.000Z' }),
      row({ id: 'b', lastMessageAt: null, createdAt: '2026-06-09T00:00:00.000Z' }),
    ]
    expect(pickMostRecentSession(rows)?.id).toBe('b')
  })

  test('lastMessageAt takes precedence over createdAt within a row', () => {
    const rows = [
      // newer createdAt but older lastMessageAt
      row({ id: 'a', createdAt: '2026-06-20T00:00:00.000Z', lastMessageAt: '2026-06-01T00:00:00.000Z' }),
      // older createdAt but newer lastMessageAt
      row({ id: 'b', createdAt: '2026-06-02T00:00:00.000Z', lastMessageAt: '2026-06-15T00:00:00.000Z' }),
    ]
    expect(pickMostRecentSession(rows)?.id).toBe('b')
  })

  test('handles a single row', () => {
    expect(pickMostRecentSession([row({ id: 'solo' })])?.id).toBe('solo')
  })
})

describe('canReseed', () => {
  test('allows reseed for repo_created and error', () => {
    expect(canReseed('repo_created')).toBe(true)
    expect(canReseed('error')).toBe(true)
  })

  test('disallows reseed for ready/seeding/pending and unknown states', () => {
    expect(canReseed('ready')).toBe(false)
    expect(canReseed('seeding')).toBe(false)
    expect(canReseed('pending')).toBe(false)
    expect(canReseed('whatever')).toBe(false)
  })
})

describe('appStatusMeta', () => {
  const app = (p: Partial<Parameters<typeof appStatusMeta>[0]>) => ({
    provisionStatus: 'ready',
    fcStatus: null,
    fcEndpoint: null,
    ...p,
  })

  test('an in-flight deploy wins over everything', () => {
    expect(appStatusMeta(app({ fcStatus: 'live', fcEndpoint: 'https://x' }), true).key)
      .toBe('apps.deploying')
  })

  test('live requires both fcStatus and an endpoint', () => {
    expect(appStatusMeta(app({ fcStatus: 'live', fcEndpoint: 'https://x' }), false).dot).toBe('live')
    // live without an endpoint is not something the user can open — fall through
    expect(appStatusMeta(app({ fcStatus: 'live', fcEndpoint: null }), false).key).toBe('apps.ready')
  })

  test('a persisted failed deploy is surfaced, not hidden behind "Ready"', () => {
    const meta = appStatusMeta(app({ fcStatus: 'deploy_error' }), false)
    expect(meta.dot).toBe('failed')
    expect(meta.key).toBe('apps.deployFailed')
  })

  test('every in-progress deploy state reads as deploying', () => {
    for (const s of ['awaiting_build', 'building', 'deploying']) {
      expect(appStatusMeta(app({ fcStatus: s }), false).key).toBe('apps.deploying')
    }
  })

  test('falls back to the provision lifecycle when never deployed', () => {
    expect(appStatusMeta(app({ provisionStatus: 'ready' }), false).key).toBe('apps.ready')
    expect(appStatusMeta(app({ provisionStatus: 'error' }), false).key).toBe('apps.error')
    expect(appStatusMeta(app({ provisionStatus: 'repo_created' }), false).key).toBe('apps.provisioning')
  })
})
