import { create } from 'zustand'
import {
  encodeWorkspaceId,
  getDaemonMcp,
  getDaemonMcpTools,
  putDaemonMcp,
  type DaemonMcpServerConfig,
} from '@/lib/daemon-local-client'
import { withAsync } from '@/lib/store-utils'
import { useWorkspaceStore } from './workspace'

function getWorkspaceId(): string | null {
  const workspacePath = useWorkspaceStore.getState().workspacePath
  return workspacePath ? encodeWorkspaceId(workspacePath) : null
}

// MCPServerConfig is re-exported so callers don't need to import from daemon-local-client.
export type MCPServerConfig = DaemonMcpServerConfig

export interface MCPTestResult {
  success: boolean
  message: string
  details?: string
}

export interface MCPServer {
  name: string
  config: MCPServerConfig
}

export type McpProbeStatus = 'skipped' | 'ready' | 'failed'

interface MCPState {
  servers: Record<string, MCPServerConfig>
  /** Legacy runtime status — not populated until daemon exposes MCP health. */
  runtimeStatus: Record<string, { status: string; error?: string }>
  serverTools: Record<string, string[]>
  serverProbe: Record<string, { status: McpProbeStatus; error?: string }>
  toolsLoading: boolean
  isLoading: boolean
  error: string | null
  testingServers: Record<string, boolean>
  testResults: Record<string, MCPTestResult>

  loadConfig: () => Promise<void>
  loadRuntimeStatus: () => Promise<void>
  loadTools: (options?: { refresh?: boolean }) => Promise<void>
  addServer: (name: string, config: MCPServerConfig) => Promise<void>
  updateServer: (name: string, config: MCPServerConfig) => Promise<void>
  removeServer: (name: string) => Promise<void>
  toggleServer: (name: string, enabled: boolean) => Promise<void>
  clearError: () => void
  clearTestResult: (name: string) => void
  /** Re-read MCP config from daemon (replaces legacy file-sync). */
  syncFromFile: () => Promise<void>
}

export const useMCPStore = create<MCPState>((set, get) => ({
  servers: {},
  runtimeStatus: {},
  serverTools: {},
  serverProbe: {},
  toolsLoading: false,
  isLoading: false,
  error: null,
  testingServers: {},
  testResults: {},

  loadConfig: async () => {
    await withAsync(set, async () => {
      const wid = getWorkspaceId()
      if (!wid) return
      const servers = await getDaemonMcp(wid)
      set({ servers })
      await get().loadTools()
    })
  },

  loadRuntimeStatus: async () => {
    // Runtime MCP status will come from daemon in a follow-up; config CRUD is live.
  },

  loadTools: async (options) => {
    await withAsync(
      set,
      async () => {
        const wid = getWorkspaceId()
        if (!wid) return
        const servers = await getDaemonMcpTools(wid, options)
        const serverTools: Record<string, string[]> = {}
        const serverProbe: Record<string, { status: McpProbeStatus; error?: string }> = {}
        for (const [name, probe] of Object.entries(servers)) {
          serverTools[name] = probe.tools
          serverProbe[name] = {
            status: probe.probe_status,
            error: probe.error ?? undefined,
          }
        }
        set({ serverTools, serverProbe })
      },
      { loadingKey: 'toolsLoading' },
    )
  },

  addServer: async (name: string, config: MCPServerConfig) => {
    await withAsync(set, async () => {
      const wid = getWorkspaceId()
      if (!wid) throw new Error('no workspace')
      const current = get().servers
      const updated = { ...current, [name]: config }
      await putDaemonMcp(wid, updated)
      set({ servers: await getDaemonMcp(wid) })
    }, { rethrow: true })
  },

  updateServer: async (name: string, config: MCPServerConfig) => {
    await withAsync(set, async () => {
      const wid = getWorkspaceId()
      if (!wid) throw new Error('no workspace')
      const current = get().servers
      const updated = { ...current, [name]: config }
      await putDaemonMcp(wid, updated)
      set({ servers: await getDaemonMcp(wid) })
    }, { rethrow: true })
  },

  removeServer: async (name: string) => {
    await withAsync(set, async () => {
      const wid = getWorkspaceId()
      if (!wid) throw new Error('no workspace')
      const current = { ...get().servers }
      delete current[name]
      await putDaemonMcp(wid, current)
      set({ servers: await getDaemonMcp(wid) })
    }, { rethrow: true })
  },

  toggleServer: async (name: string, enabled: boolean) => {
    await withAsync(set, async () => {
      const wid = getWorkspaceId()
      if (!wid) throw new Error('no workspace')
      const current = get().servers
      if (!(name in current)) return
      const updated = { ...current, [name]: { ...current[name], enabled } }
      await putDaemonMcp(wid, updated)
      set({ servers: await getDaemonMcp(wid) })
    }, { rethrow: true })
  },

  clearError: () => set({ error: null }),

  clearTestResult: (name: string) => {
    set((state) => {
      const newResults = { ...state.testResults }
      delete newResults[name]
      return { testResults: newResults }
    })
  },

  syncFromFile: async () => {
    const wid = getWorkspaceId()
    if (!wid) return
    try {
      set({ servers: await getDaemonMcp(wid) })
    } catch (error) {
      console.error('[MCP] syncFromFile failed:', error)
    }
  },
}))
