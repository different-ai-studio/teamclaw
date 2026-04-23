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

  it('syncs provider.json into workspace opencode.json', async () => {
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

    const { syncTeamProviderToOpenCode } = await import('@/lib/team-provider')
    const result = await syncTeamProviderToOpenCode('/workspace')

    expect(result?.provider.baseURL).toBe('https://ai.ucar.cc')
    expect(mockAddCustomProviderToConfig).toHaveBeenCalledWith('/workspace', {
      name: 'Team',
      baseURL: 'https://ai.ucar.cc',
      apiKey: '${tc_api_key}',
      models: [
        { modelId: 'default', modelName: 'Default', limit: { context: 256000, output: 16000 } },
        { modelId: 'pro', modelName: 'Pro', limit: { context: 256000, output: 16000 } },
      ],
    })
  })

  it('removes the shared provider from opencode.json when provider.json is absent', async () => {
    const { syncTeamProviderToOpenCode } = await import('@/lib/team-provider')
    const result = await syncTeamProviderToOpenCode('/workspace')

    expect(result).toBeNull()
    expect(mockRemoveCustomProviderFromConfig).toHaveBeenCalledWith('/workspace', 'team')
  })
})
