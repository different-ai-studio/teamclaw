import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/lib/opencode/sdk-client', () => ({
  getOpenCodeClient: () => ({
    getMCPStatus: vi.fn().mockResolvedValue({}),
  }),
}))

vi.mock('@/lib/store-utils', () => ({
  withAsync: async (set: any, fn: any, opts?: any) => {
    set({ isLoading: true, error: null })
    try {
      const result = await fn()
      set({ isLoading: false })
      return result
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), isLoading: false })
      if (opts?.rethrow) throw error
    }
  },
}))

import { useMCPStore } from '@/stores/mcp'

describe('mcp store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useMCPStore.setState({
      servers: {},
      runtimeStatus: {},
      serverTools: {},
      isLoading: false,
      error: null,
      testingServers: {},
      testResults: {},
    })
  })

  it('has correct initial state', () => {
    const state = useMCPStore.getState()
    expect(state.servers).toEqual({})
    expect(state.isLoading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('loadConfig fetches and sets servers', async () => {
    const mockConfig = { myServer: { type: 'local', command: ['node', 'server.js'] } }
    mockInvoke.mockResolvedValue(mockConfig)

    await useMCPStore.getState().loadConfig()

    expect(mockInvoke).toHaveBeenCalledWith('get_mcp_config', expect.any(Object))
    expect(useMCPStore.getState().servers).toEqual(mockConfig)
  })

  it('clearError resets error to null', () => {
    useMCPStore.setState({ error: 'some error' })
    useMCPStore.getState().clearError()
    expect(useMCPStore.getState().error).toBeNull()
  })

  it('clearTestResult removes the specified test result', () => {
    useMCPStore.setState({ testResults: { srv1: { success: true, message: 'ok' }, srv2: { success: false, message: 'fail' } } })
    useMCPStore.getState().clearTestResult('srv1')
    expect(useMCPStore.getState().testResults).toEqual({ srv2: { success: false, message: 'fail' } })
  })
})
