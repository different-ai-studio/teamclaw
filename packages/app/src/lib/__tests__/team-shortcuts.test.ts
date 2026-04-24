import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TEAM_REPO_DIR } from '@/lib/build-config'

const mockExists = vi.fn()
const mockReadTextFile = vi.fn()
const mockWriteTextFile = vi.fn()
const mockMkdir = vi.fn()

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mockExists,
  readTextFile: mockReadTextFile,
  writeTextFile: mockWriteTextFile,
  mkdir: mockMkdir,
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

describe('team-shortcuts loader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('returns null when file does not exist', async () => {
    mockExists.mockResolvedValue(false)
    
    const { loadTeamShortcutsFile } = await import('@/lib/team-shortcuts')
    const result = await loadTeamShortcutsFile('/workspace')
    
    expect(result).toBeNull()
    expect(mockExists).toHaveBeenCalledWith(`/workspace/${TEAM_REPO_DIR}/_meta/shortcuts.json`)
  })

  it('parses valid shortcuts file', async () => {
    const mockData = {
      version: 1,
      shortcuts: [
        { id: 'team-1', label: 'API Docs', type: 'link', target: 'https://api.example.com', order: 0, parentId: null, role: ['sales'] }
      ]
    }
    mockExists.mockResolvedValue(true)
    mockReadTextFile.mockResolvedValue(JSON.stringify(mockData))
    
    const { loadTeamShortcutsFile } = await import('@/lib/team-shortcuts')
    const result = await loadTeamShortcutsFile('/workspace')
    
    expect(result).toHaveLength(1)
    expect(result![0].label).toBe('API Docs')
    expect(result![0].role).toEqual(['sales'])
  })

  it('returns null for malformed JSON', async () => {
    mockExists.mockResolvedValue(true)
    mockReadTextFile.mockResolvedValue('not json')
    
    const { loadTeamShortcutsFile } = await import('@/lib/team-shortcuts')
    const result = await loadTeamShortcutsFile('/workspace')
    
    expect(result).toBeNull()
  })

  it('creates _meta directory before saving', async () => {
    mockExists.mockResolvedValue(false)

    const { saveTeamShortcutsFile } = await import('@/lib/team-shortcuts')
    const ok = await saveTeamShortcutsFile('/workspace', [
      { id: 'team-1', label: 'Team', order: 0, parentId: null, type: 'link', target: 'https://team.example.com', role: ['sales'] },
    ])

    expect(ok).toBe(true)
    expect(mockExists).toHaveBeenCalledWith(`/workspace/${TEAM_REPO_DIR}/_meta`)
    expect(mockMkdir).toHaveBeenCalledWith(`/workspace/${TEAM_REPO_DIR}/_meta`, { recursive: true })
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      `/workspace/${TEAM_REPO_DIR}/_meta/shortcuts.json`,
      JSON.stringify({
        version: 1,
        shortcuts: [
          { id: 'team-1', label: 'Team', order: 0, parentId: null, type: 'link', target: 'https://team.example.com', role: ['sales'] },
        ],
      }, null, 2),
    )
  })
})
