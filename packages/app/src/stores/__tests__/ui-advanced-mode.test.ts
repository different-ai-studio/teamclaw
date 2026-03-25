import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CONFIG_FILE_NAME } from '@/lib/build-config'
import { useUIStore } from '../ui'

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

// Mock workspace store — must be at top level for ESM compatibility
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/workspace', activeTab: 'shortcuts', openPanel: vi.fn() }),
  },
}))

describe('UI Store - advancedMode', () => {
  beforeEach(() => {
    useUIStore.setState({ advancedMode: false, layoutMode: 'task', fileModeRightTab: 'agent' })
    vi.clearAllMocks()
  })

  it('defaults to false', () => {
    expect(useUIStore.getState().advancedMode).toBe(false)
  })

  it('setAdvancedMode updates store state', () => {
    useUIStore.getState().setAdvancedMode(true, null)
    expect(useUIStore.getState().advancedMode).toBe(true)
  })

  it('setAdvancedMode(false) resets layoutMode from file to task', () => {
    useUIStore.setState({ advancedMode: true, layoutMode: 'file' })
    useUIStore.getState().setAdvancedMode(false, null)
    expect(useUIStore.getState().layoutMode).toBe('task')
  })

  it('setAdvancedMode(false) resets fileModeRightTab to shortcuts', () => {
    useUIStore.setState({ advancedMode: true, fileModeRightTab: 'changes' })
    useUIStore.getState().setAdvancedMode(false, null)
    expect(useUIStore.getState().fileModeRightTab).toBe('shortcuts')
  })

  it('loadAdvancedMode defaults to false when file does not exist', async () => {
    const { exists } = await import('@tauri-apps/plugin-fs')
    vi.mocked(exists).mockResolvedValue(false)

    await useUIStore.getState().loadAdvancedMode('/workspace')
    expect(useUIStore.getState().advancedMode).toBe(false)
  })

  it(`loadAdvancedMode reads true from valid ${CONFIG_FILE_NAME}`, async () => {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify({ advancedMode: true }))

    await useUIStore.getState().loadAdvancedMode('/workspace')
    expect(useUIStore.getState().advancedMode).toBe(true)
  })

  it('loadAdvancedMode defaults to false on malformed JSON', async () => {
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
