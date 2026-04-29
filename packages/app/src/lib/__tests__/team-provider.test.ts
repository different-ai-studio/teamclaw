import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockExists = vi.fn()
const mockMkdir = vi.fn()
const mockReadTextFile = vi.fn()
const mockWriteTextFile = vi.fn()
const mockRemove = vi.fn()
const mockAddCustomProviderToConfig = vi.fn()
const mockRemoveCustomProviderFromConfig = vi.fn()

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mockExists,
  mkdir: mockMkdir,
  readTextFile: mockReadTextFile,
  writeTextFile: mockWriteTextFile,
  remove: mockRemove,
}))

vi.mock('@/lib/opencode/config', () => ({
  addCustomProviderToConfig: mockAddCustomProviderToConfig,
  removeCustomProviderFromConfig: mockRemoveCustomProviderFromConfig,
}))

vi.mock('@/lib/build-config', () => ({
  TEAM_REPO_DIR: 'teamclaw-team',
}))

describe('team provider file helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExists.mockResolvedValue(false)
    mockMkdir.mockResolvedValue(undefined)
    mockReadTextFile.mockResolvedValue('')
    mockWriteTextFile.mockResolvedValue(undefined)
    mockRemove.mockResolvedValue(undefined)
    mockAddCustomProviderToConfig.mockResolvedValue('team')
    mockRemoveCustomProviderFromConfig.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('creates _meta/provider.json for the shared team provider', async () => {
    const { saveTeamProviderFile } = await import('@/lib/team-provider')

    await saveTeamProviderFile(
      '/workspace',
      {
        name: 'Team',
        baseURL: 'https://ai.ucar.cc',
        apiKey: '${tc_api_key}',
        models: [
          { modelId: 'default', modelName: 'Default' },
          { modelId: 'pro', modelName: 'Pro' },
        ],
      },
      'default',
    )

    expect(mockExists).toHaveBeenCalledWith('/workspace/teamclaw-team/_meta')
    expect(mockMkdir).toHaveBeenCalledWith('/workspace/teamclaw-team/_meta', { recursive: true })
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      '/workspace/teamclaw-team/_meta/provider.json',
      JSON.stringify({
        version: 1,
        provider: {
          id: 'team',
          name: 'Team',
          baseURL: 'https://ai.ucar.cc',
          apiKey: '${tc_api_key}',
          defaultModel: 'default',
          models: [
            { id: 'default', name: 'Default' },
            { id: 'pro', name: 'Pro' },
          ],
        },
      }, null, 2),
    )
  })

  it('loads provider.json into a TeamProviderFile', async () => {
    mockExists.mockImplementation(async (path: string) => path === '/workspace/teamclaw-team/_meta/provider.json')
    mockReadTextFile.mockResolvedValue(JSON.stringify({
      version: 1,
      provider: {
        id: 'team',
        name: 'Team',
        baseURL: 'https://ai.ucar.cc',
        apiKey: '${tc_api_key}',
        defaultModel: 'pro',
        models: [
          { id: 'default', name: 'Default' },
          { id: 'pro', name: 'Pro' },
        ],
      },
    }))

    const { loadTeamProviderFile } = await import('@/lib/team-provider')
    const result = await loadTeamProviderFile('/workspace')

    expect(result?.provider.baseURL).toBe('https://ai.ucar.cc')
    expect(result?.provider.models).toHaveLength(2)
    expect(mockAddCustomProviderToConfig).not.toHaveBeenCalled()
  })

  it('returns null when provider.json is absent and never writes opencode.json', async () => {
    const { loadTeamProviderFile } = await import('@/lib/team-provider')
    const result = await loadTeamProviderFile('/workspace')

    expect(result).toBeNull()
    expect(mockAddCustomProviderToConfig).not.toHaveBeenCalled()
    expect(mockRemoveCustomProviderFromConfig).not.toHaveBeenCalled()
  })

  it('saveTeamProviderFile is a no-op on null provider (no implicit deletion)', async () => {
    // Regression: previously, passing null deleted _meta/provider.json.
    // That caused team-wide loss whenever a member joined with an empty form
    // and the deletion got auto-committed by the next sync.
    mockExists.mockResolvedValue(true) // provider.json exists on disk
    const { saveTeamProviderFile } = await import('@/lib/team-provider')

    await saveTeamProviderFile('/workspace', null)

    expect(mockRemove).not.toHaveBeenCalled()
    expect(mockWriteTextFile).not.toHaveBeenCalled()
  })

  it('removeTeamProviderFile deletes provider.json when present', async () => {
    mockExists.mockImplementation(
      async (path: string) => path === '/workspace/teamclaw-team/_meta/provider.json',
    )
    const { removeTeamProviderFile } = await import('@/lib/team-provider')

    await removeTeamProviderFile('/workspace')

    expect(mockRemove).toHaveBeenCalledWith('/workspace/teamclaw-team/_meta/provider.json')
  })

  it('removeTeamProviderFile is a no-op when provider.json is absent', async () => {
    mockExists.mockResolvedValue(false)
    const { removeTeamProviderFile } = await import('@/lib/team-provider')

    await removeTeamProviderFile('/workspace')

    expect(mockRemove).not.toHaveBeenCalled()
  })
})
