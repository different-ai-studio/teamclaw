import { describe, it, expect } from 'vitest'
import { formatActorRemoveError } from '../actor-remove-error'

const t = (key: string, fallback?: string, opts?: Record<string, unknown>) => {
  const fb = typeof fallback === 'string' ? fallback : key
  if (opts) return fb.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts[name] ?? ''))
  return fb
}

describe('formatActorRemoveError', () => {
  it('maps last owner error', () => {
    expect(formatActorRemoveError('cannot remove the last owner', t)).toMatch(/last team owner/i)
  })

  it('maps self-remove error', () => {
    expect(formatActorRemoveError('cannot remove your own actor', t)).toMatch(/yourself/i)
  })

  it('maps FK owner_member_id error', () => {
    expect(formatActorRemoveError('violates foreign key constraint "agents_owner_member_id_fkey"', t)).toMatch(/owns one or more agents/i)
  })

  it('falls back to generic message', () => {
    expect(formatActorRemoveError('something unexpected', t)).toBe('Remove failed: something unexpected')
  })
})
