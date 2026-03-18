import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { getOpenCodeClient } from '@/lib/opencode/client'
import type { MCPRuntimeStatus } from '@/lib/opencode/types'
import { withAsync } from '@/lib/store-utils'

// MCP Server configuration types
export interface MCPServerConfig {
  type: 'local' | 'remote'
  enabled?: boolean
  command?: string[]  // for local
  environment?: Record<string, string>
  url?: string  // for remote
  headers?: Record<string, string>
  timeout?: number
}

// MCP Test result types
export interface MCPTestResult {
  success: boolean
  message: string
  details?: string
}

export interface MCPServer {
  name: string
  config: MCPServerConfig
}

interface MCPState {
  servers: Record<string, MCPServerConfig>
  runtimeStatus: Record<string, MCPRuntimeStatus>
  serverTools: Record<string, string[]>  // serverName -> tool names
  isLoading: boolean
  error: string | null
  hasChanges: boolean  // Track if there are unsaved changes that need OpenCode restart
  testingServers: Record<string, boolean>  // Track which servers are being tested
  testResults: Record<string, MCPTestResult>  // Store test results

  // Actions
  loadConfig: () => Promise<void>
  loadRuntimeStatus: () => Promise<void>
  loadTools: () => Promise<void>
  addServer: (name: string, config: MCPServerConfig) => Promise<void>
  updateServer: (name: string, config: MCPServerConfig) => Promise<void>
  removeServer: (name: string) => Promise<void>
  toggleServer: (name: string, enabled: boolean) => Promise<void>
  testServer: (name: string) => Promise<void>
  clearError: () => void
  setHasChanges: (hasChanges: boolean) => void
  clearTestResult: (name: string) => void
}

export const useMCPStore = create<MCPState>((set) => ({
  servers: {},
  runtimeStatus: {},
  serverTools: {},
  isLoading: false,
  error: null,
  hasChanges: false,
  testingServers: {},
  testResults: {},

  loadConfig: async () => {
    await withAsync(set, async () => {
      const config = await invoke<Record<string, MCPServerConfig>>('get_mcp_config')
      set({ servers: config, hasChanges: false })
    })
  },

  loadRuntimeStatus: async () => {
    try {
      // Fetch runtime status from OpenCode API
      let client
      try {
        client = getOpenCodeClient()
      } catch {
        return // Client not initialized yet
      }
      const statusMap = await client.getMCPStatus().catch(() => ({} as Record<string, MCPRuntimeStatus>))
      set({ runtimeStatus: statusMap })
    } catch (error) {
      console.error('Failed to load MCP runtime status:', error)
    }
  },

  loadTools: async () => {
    try {
      // Query each MCP server directly for its tools (via Tauri command)
      const toolMap = await invoke<Record<string, string[]>>('list_mcp_tools')
      set({ serverTools: toolMap })
    } catch (error) {
      console.error('Failed to load MCP tools:', error)
    }
  },

  addServer: async (name: string, config: MCPServerConfig) => {
    await withAsync(set, async () => {
      await invoke('add_mcp_server', { name, serverConfig: config })
      const updatedConfig = await invoke<Record<string, MCPServerConfig>>('get_mcp_config')
      set({ servers: updatedConfig, hasChanges: true })
    }, { rethrow: true })
  },

  updateServer: async (name: string, config: MCPServerConfig) => {
    await withAsync(set, async () => {
      await invoke('update_mcp_server', { name, serverConfig: config })
      const updatedConfig = await invoke<Record<string, MCPServerConfig>>('get_mcp_config')
      set({ servers: updatedConfig, hasChanges: true })
    }, { rethrow: true })
  },

  removeServer: async (name: string) => {
    await withAsync(set, async () => {
      await invoke('remove_mcp_server', { name })
      const updatedConfig = await invoke<Record<string, MCPServerConfig>>('get_mcp_config')
      set({ servers: updatedConfig, hasChanges: true })
    }, { rethrow: true })
  },

  toggleServer: async (name: string, enabled: boolean) => {
    await withAsync(set, async () => {
      await invoke('toggle_mcp_server', { name, enabled })
      const updatedConfig = await invoke<Record<string, MCPServerConfig>>('get_mcp_config')
      set({ servers: updatedConfig, hasChanges: true })
    }, { rethrow: true })
  },

  testServer: async (name: string) => {
    set((state) => ({
      testingServers: { ...state.testingServers, [name]: true },
    }))
    try {
      const result = await invoke<MCPTestResult>('test_mcp_server', { name })
      set((state) => ({
        testingServers: { ...state.testingServers, [name]: false },
        testResults: { ...state.testResults, [name]: result },
      }))
    } catch (error) {
      set((state) => ({
        testingServers: { ...state.testingServers, [name]: false },
        testResults: {
          ...state.testResults,
          [name]: {
            success: false,
            message: error instanceof Error ? error.message : String(error),
            details: undefined,
          },
        },
      }))
    }
  },

  clearError: () => set({ error: null }),
  
  setHasChanges: (hasChanges: boolean) => set({ hasChanges }),

  clearTestResult: (name: string) => {
    set((state) => {
      const newResults = { ...state.testResults }
      delete newResults[name]
      return { testResults: newResults }
    })
  },
}))
