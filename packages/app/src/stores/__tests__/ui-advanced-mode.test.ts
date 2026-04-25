import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CONFIG_FILE_NAME, TEAMCLAW_DIR } from '@/lib/build-config'
import { useUIStore } from '../ui'

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

// Mock Tauri modules
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
}))

vi.mock('@tauri-apps/api/path', () => ({
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join('/'))),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(vi.fn())),
}))

// Mock workspace store — must be at top level for ESM compatibility
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/workspace', activeTab: 'shortcuts', openPanel: vi.fn() }),
  },
}))

describe('UI Store - advancedMode', () => {
  beforeEach(() => {
    useUIStore.setState({ advancedMode: true, layoutMode: 'task', fileModeRightTab: 'agent' })
    vi.clearAllMocks()
  })

  it('setAdvancedMode(false) disables advanced mode', async () => {
    await useUIStore.getState().setAdvancedMode(false, null)

    expect(useUIStore.getState().advancedMode).toBe(false)
  })

  it(`setAdvancedMode writes ${CONFIG_FILE_NAME} while preserving other fields`, async () => {
    const { exists, readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs')
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify({ team: { enabled: true }, advancedMode: false }))

    await useUIStore.getState().setAdvancedMode(true, '/workspace')

    expect(writeTextFile).toHaveBeenCalledWith(
      `/workspace/${TEAMCLAW_DIR}/${CONFIG_FILE_NAME}`,
      `${JSON.stringify({ team: { enabled: true }, advancedMode: true }, null, 2)}\n`,
    )
  })

  it('setAdvancedMode(false) keeps layoutMode unchanged', async () => {
    useUIStore.setState({ advancedMode: true, layoutMode: 'file' })
    await useUIStore.getState().setAdvancedMode(false, null)

    expect(useUIStore.getState().layoutMode).toBe('file')
  })

  it('setAdvancedMode(false) keeps fileModeRightTab unchanged', async () => {
    useUIStore.setState({ advancedMode: true, fileModeRightTab: 'changes' })
    await useUIStore.getState().setAdvancedMode(false, null)

    expect(useUIStore.getState().fileModeRightTab).toBe('changes')
  })

  it('loadAdvancedMode defaults to false when config file does not exist', async () => {
    const { exists } = await import('@tauri-apps/plugin-fs')
    vi.mocked(exists).mockResolvedValue(false)

    await useUIStore.getState().loadAdvancedMode('/workspace')
    expect(useUIStore.getState().advancedMode).toBe(false)
  })

  it(`loadAdvancedMode reads advancedMode from ${CONFIG_FILE_NAME}`, async () => {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify({ advancedMode: true }))

    await useUIStore.getState().loadAdvancedMode('/workspace')
    expect(useUIStore.getState().advancedMode).toBe(true)
  })

  it('loadAdvancedMode resets to false on malformed JSON', async () => {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue('not json{{{')

    await useUIStore.getState().loadAdvancedMode('/workspace')
    expect(useUIStore.getState().advancedMode).toBe(false)
  })

  it('loadAdvancedMode defaults to false when advancedMode field is missing', async () => {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify({ team: {} }))

    await useUIStore.getState().loadAdvancedMode('/workspace')
    expect(useUIStore.getState().advancedMode).toBe(false)
  })
})
