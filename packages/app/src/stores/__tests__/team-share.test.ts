import { describe, expect, it } from 'vitest'
import { normalizeShareStatus, type ShareStatus } from '../team-share'

describe('ShareStatus shape', () => {
  it('carries link status and global path', () => {
    const s: ShareStatus = {
      mode: 'oss',
      linkStatus: 'symlink',
      globalPath: '/home/u/.amuxd/teams/team-1/teamclaw-team',
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
  it('strips orphan git fields when mode is unset', () => {
    const normalized = normalizeShareStatus({
      mode: null,
      gitRemoteUrl: 'https://git.example.com/repo.git',
      gitAuthKind: 'https_token',
      linkStatus: 'symlink',
      globalPath: '/home/u/.amuxd/teams/t/teamclaw-team',
    })
    expect(normalized.mode).toBeNull()
    expect(normalized.gitRemoteUrl).toBeNull()
    expect(normalized.gitAuthKind).toBeNull()
    expect(normalized.linkStatus).toBe('symlink')
  })

  it('keeps git fields when mode is locked', () => {
    const normalized = normalizeShareStatus({
      mode: 'custom_git',
      gitRemoteUrl: 'https://git.example.com/repo.git',
      gitAuthKind: 'https_token',
    })
    expect(normalized.mode).toBe('custom_git')
    expect(normalized.gitRemoteUrl).toBe('https://git.example.com/repo.git')
  })
})
