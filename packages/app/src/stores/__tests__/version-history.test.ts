import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { useVersionHistoryStore } from '../version-history'

describe('version-history store', () => {
  beforeEach(() => {
    invoke.mockReset()
    useVersionHistoryStore.getState().reset()
  })

  it('loads file versions by ref (no inline content)', async () => {
    invoke.mockResolvedValueOnce({
      versions: [{ ref: 'sha2', author: 'a', timestamp: '2026-01-02', deleted: false, message: 'm2' }],
      nextCursor: null,
    })
    await useVersionHistoryStore.getState().loadFileVersions('team-1', 'skills/x.md')
    const v = useVersionHistoryStore.getState().fileVersions[0]
    expect(v.ref).toBe('sha2')
    expect(invoke).toHaveBeenCalledWith('team_file_versions', { teamId: 'team-1', path: 'skills/x.md' })
  })

  it('fetches content lazily for a selected ref', async () => {
    invoke.mockResolvedValueOnce({ content: 'hello' })
    const content = await useVersionHistoryStore
      .getState()
      .fetchVersionContent('team-1', 'skills/x.md', 'sha2')
    expect(content).toBe('hello')
    expect(invoke).toHaveBeenCalledWith('team_file_content', { teamId: 'team-1', path: 'skills/x.md', ref: 'sha2' })
  })

  it('loads changed files', async () => {
    invoke.mockResolvedValueOnce({ files: [{ path: 'a.md', status: 'modified' }] })
    await useVersionHistoryStore.getState().loadVersionedFiles('team-1')
    expect(useVersionHistoryStore.getState().versionedFiles[0]).toEqual({ path: 'a.md', status: 'modified' })
    expect(invoke).toHaveBeenCalledWith('team_changed_files', { teamId: 'team-1' })
  })
})
