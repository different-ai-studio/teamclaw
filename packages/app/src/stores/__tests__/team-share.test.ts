import { describe, expect, it } from 'vitest'
import { normalizeShareStatus, type ShareStatus } from '../team-share'

describe('ShareStatus shape', () => {
  it('carries link status and global path', () => {
    const s: ShareStatus = {
      mode: 'oss',
      linkStatus: 'symlink',
      globalPath: '/home/u/.amuxd/teams/team-1/teamclu-team',
    }
    expect(s.linkStatus).toBe('symlink')
    expect(s.globalPath).toContain('.amuxd/teams/team-1')
  })

  it('allows the three link states', () => {
    const states: ShareStatus['linkStatus'][] = [
      'symlink',
      'real_dir',
      'missing',
    ]
    expect(states).toHaveLength(3)
  })
})

describe('normalizeShareStatus', () => {
  it('keeps the link fields when mode is unset', () => {
    const normalized = normalizeShareStatus({
      mode: null,
      linkStatus: 'symlink',
      globalPath: '/home/u/.amuxd/teams/t/teamclu-team',
    })
    expect(normalized.mode).toBeNull()
    expect(normalized.enabledAt).toBeNull()
    expect(normalized.linkStatus).toBe('symlink')
  })

  it('keeps the mode when it is locked', () => {
    const normalized = normalizeShareStatus({
      mode: 'oss',
      enabledAt: '2026-06-01T00:00:00Z',
    })
    expect(normalized.mode).toBe('oss')
    expect(normalized.enabledAt).toBe('2026-06-01T00:00:00Z')
  })

  it('treats a retired git mode as not enabled', () => {
    const normalized = normalizeShareStatus({
      mode: 'custom_git' as never,
    })
    expect(normalized.mode).toBeNull()
  })
})
