import { describe, it, expect, vi, beforeEach } from 'vitest'

const listVersions = vi.fn()
const getVersionContent = vi.fn()

vi.mock('@/stores/oss-sync', () => ({
  useOssSyncStore: {
    getState: () => ({ listVersions, getVersionContent }),
  },
}))

import { OssHistoryProvider } from '../oss-provider'

describe('OssHistoryProvider', () => {
  beforeEach(() => {
    listVersions.mockReset()
    getVersionContent.mockReset()
  })

  it('maps VersionInfo to HistoryEntry and resolves parentRef from loaded versions', async () => {
    listVersions.mockResolvedValue({
      versions: [
        { version: 3, parentVersion: 2, contentHash: 'h3', size: 1, deleted: false, createdBy: 'Alice', createdByNodeId: null, createdAt: '2026-05-03T00:00:00Z', message: 'edit' },
        { version: 2, parentVersion: 1, contentHash: 'h2', size: 1, deleted: false, createdBy: null, createdByNodeId: 'node-x', createdAt: '2026-05-02T00:00:00Z', message: null },
        { version: 1, parentVersion: 0, contentHash: 'h1', size: 1, deleted: false, createdBy: 'Bob', createdByNodeId: null, createdAt: '2026-05-01T00:00:00Z', message: 'init' },
      ],
      nextCursor: null,
    })

    const p = new OssHistoryProvider('/ws', 'knowledge/a.md')
    const page = await p.list(null)

    expect(listVersions).toHaveBeenCalledWith('/ws', 'knowledge/a.md', null)
    expect(page.entries[0]).toEqual({
      ref: 'h3',
      parentRef: 'h2',
      label: 'v3',
      author: 'Alice',
      timestamp: '2026-05-03T00:00:00Z',
      message: 'edit',
    })
    expect(page.entries[1].author).toBe('node-x')
    expect(page.entries[2].parentRef).toBe('')
    expect(page.nextCursor).toBeNull()
  })

  it('accumulates version->hash across pages so parentRef resolves at page boundary', async () => {
    listVersions
      .mockResolvedValueOnce({
        versions: [
          { version: 2, parentVersion: 1, contentHash: 'h2', size: 1, deleted: false, createdBy: null, createdByNodeId: null, createdAt: 't2', message: null },
        ],
        nextCursor: 'CURSOR1',
      })
      .mockResolvedValueOnce({
        versions: [
          { version: 1, parentVersion: 0, contentHash: 'h1', size: 1, deleted: false, createdBy: null, createdByNodeId: null, createdAt: 't1', message: null },
        ],
        nextCursor: null,
      })

    const p = new OssHistoryProvider('/ws', 'a.md')
    const first = await p.list(null)
    expect(first.entries[0].parentRef).toBe('')
    expect(first.nextCursor).toBe('CURSOR1')

    await p.list('CURSOR1')
    expect(listVersions).toHaveBeenLastCalledWith('/ws', 'a.md', 'CURSOR1')
  })

  it('getContent delegates to store; empty ref yields empty string', async () => {
    getVersionContent.mockResolvedValue('plain text')
    const p = new OssHistoryProvider('/ws', 'a.md')
    expect(await p.getContent('h9')).toBe('plain text')
    expect(getVersionContent).toHaveBeenCalledWith('/ws', 'h9')
    expect(await p.getContent('')).toBe('')
  })
})
