import { describe, test, expect } from 'vitest'
import { pickMostRecentSession, canReseed } from '../AppsListColumn'
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
