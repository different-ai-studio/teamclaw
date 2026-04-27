import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn().mockResolvedValue('/home'),
  join: (...parts: string[]) => Promise.resolve(parts.join('/')),
  dirname: (p: string) => Promise.resolve(p.split('/').slice(0, -1).join('/')),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(false),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn().mockResolvedValue('{}'),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
}))

import { gitManager } from '../manager'
import type { GitLogEntry } from '../types'

describe('gitManager.logFile', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('invokes git_log_file with the right args and returns entries', async () => {
    const stub: GitLogEntry[] = [
      {
        sha: 'abc123',
        parentSha: 'def456',
        author: 'Alice',
        isoTime: '2026-04-27T10:00:00+00:00',
        subject: 'first commit',
      },
    ]
    invokeMock.mockResolvedValueOnce(stub)

    const out = await gitManager.logFile('/repo', 'a.txt', 50, 0)

    expect(invokeMock).toHaveBeenCalledWith('git_log_file', {
      path: '/repo',
      file: 'a.txt',
      limit: 50,
      skip: 0,
    })
    expect(out).toEqual(stub)
  })

  it('propagates errors from invoke', async () => {
    invokeMock.mockRejectedValueOnce(new Error('boom'))
    await expect(gitManager.logFile('/repo', 'a.txt', 50, 0)).rejects.toThrow('boom')
  })
})
