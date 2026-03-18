import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
    expect(mockExists).toHaveBeenCalledWith('/workspace/teamclaw-team/.shortcuts.json')
  })

  it('parses valid shortcuts file', async () => {
    const mockData = {
      version: 1,
      shortcuts: [
        { id: 'team-1', label: 'API Docs', type: 'link', target: 'https://api.example.com', order: 0, parentId: null }
      ]
    }
    mockExists.mockResolvedValue(true)
    mockReadTextFile.mockResolvedValue(JSON.stringify(mockData))
    
    const { loadTeamShortcutsFile } = await import('@/lib/team-shortcuts')
    const result = await loadTeamShortcutsFile('/workspace')
    
    expect(result).toHaveLength(1)
    expect(result![0].label).toBe('API Docs')
  })

  it('returns null for malformed JSON', async () => {
    mockExists.mockResolvedValue(true)
    mockReadTextFile.mockResolvedValue('not json')
    
    const { loadTeamShortcutsFile } = await import('@/lib/team-shortcuts')
    const result = await loadTeamShortcutsFile('/workspace')
    
    expect(result).toBeNull()
  })
})