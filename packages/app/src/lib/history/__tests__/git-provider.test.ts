import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/git/manager', () => ({
  gitManager: {
    logFile: vi.fn(),
    showFile: vi.fn(),
  },
}))

import { gitManager } from '@/lib/git/manager'
import { GitHistoryProvider } from '../git-provider'

const logFile = gitManager.logFile as ReturnType<typeof vi.fn>
const showFile = gitManager.showFile as ReturnType<typeof vi.fn>

describe('GitHistoryProvider', () => {
  beforeEach(() => {
    logFile.mockReset()
    showFile.mockReset()
  })

  it('maps GitLogEntry to HistoryEntry and sets nextCursor when full page', async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({
      sha: `sha${i}`,
      parentSha: i === 49 ? '' : `sha${i + 1}`,
      author: 'Alice',
      isoTime: '2026-05-01T00:00:00+00:00',
      subject: `commit ${i}`,
    }))
    logFile.mockResolvedValue(full)

    const p = new GitHistoryProvider('/ws/teamclaw-team', 'knowledge/a.md', '/ws/teamclaw-team/knowledge/a.md')
    const page = await p.list(null)

    expect(logFile).toHaveBeenCalledWith('/ws/teamclaw-team', 'knowledge/a.md', 50, 0)
    expect(page.entries[0]).toEqual({
      ref: 'sha0',
      parentRef: 'sha1',
      label: 'sha0',
      author: 'Alice',
      timestamp: '2026-05-01T00:00:00+00:00',
      message: 'commit 0',
    })
    expect(page.nextCursor).toBe('50')
  })

  it('returns null nextCursor when page is not full', async () => {
    logFile.mockResolvedValue([
      { sha: 'a', parentSha: '', author: 'B', isoTime: 't', subject: 's' },
    ])
    const p = new GitHistoryProvider('/repo', 'f.md', '/repo/f.md')
    const page = await p.list(null)
    expect(page.nextCursor).toBeNull()
    expect(page.entries[0].parentRef).toBe('')
  })

  it('decodes cursor to skip on subsequent pages', async () => {
    logFile.mockResolvedValue([])
    const p = new GitHistoryProvider('/repo', 'f.md', '/repo/f.md')
    await p.list('50')
    expect(logFile).toHaveBeenCalledWith('/repo', 'f.md', 50, 50)
  })

  it('getContent delegates to gitManager.showFile', async () => {
    showFile.mockResolvedValue('file body')
    const p = new GitHistoryProvider('/repo', 'f.md', '/repo/f.md')
    const out = await p.getContent('deadbeef')
    expect(showFile).toHaveBeenCalledWith('/repo', 'f.md', 'deadbeef')
    expect(out).toBe('file body')
  })
})
