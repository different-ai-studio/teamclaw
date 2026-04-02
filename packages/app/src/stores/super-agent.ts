import { create } from 'zustand'
import { isTauri } from '@/lib/utils'

// Types must match Rust backend's SuperAgentSnapshot exactly
export type AgentStatus = 'online' | 'offline' | 'busy' | 'unknown'

export interface Capability {
  name: string
  description: string
}

export interface AgentProfile {
  agentId: string
  name: string
  status: AgentStatus
  capabilities: Capability[]
  domain: string | null
}

export interface SuperAgentSnapshot {
  localAgent: AgentProfile | null
  agents: AgentProfile[]
  connected: boolean
}

const DEFAULT_SNAPSHOT: SuperAgentSnapshot = {
  localAgent: null,
  agents: [],
  connected: false,
}

export function isSuperAgentSnapshot(value: unknown): value is SuperAgentSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SuperAgentSnapshot>
  return Array.isArray(candidate.agents) && typeof candidate.connected === 'boolean'
}

interface SuperAgentState {
  snapshot: SuperAgentSnapshot
  initialized: boolean
  init: () => Promise<() => void>
  fetch: () => Promise<void>
  discover: (domain: string) => Promise<void>
}

export const useSuperAgentStore = create<SuperAgentState>((set, get) => ({
  snapshot: DEFAULT_SNAPSHOT,
  initialized: false,

  init: async () => {
    if (get().initialized) {
      return () => {}
    }

    if (!isTauri()) {
      set({ initialized: true })
      return () => {}
    }

    const { listen } = await import('@tauri-apps/api/event')

    const unlisten = await listen<SuperAgentSnapshot>('super-agent:snapshot', (event) => {
      set({ snapshot: event.payload })
    })

    set({ initialized: true })

    // Fetch initial state after subscribing to avoid missing early events
    await get().fetch()

    return () => {
      unlisten()
      set({ initialized: false })
    }
  },

  fetch: async () => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const snapshot = await invoke<SuperAgentSnapshot | null>('super_agent_snapshot')
      if (isSuperAgentSnapshot(snapshot)) {
        set({ snapshot })
      }
    } catch (err) {
      console.warn('[SuperAgent] Failed to fetch super agent snapshot:', err)
    }
  },

  discover: async (domain: string) => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('super_agent_discover', { domain })
    } catch (err) {
      console.warn('[SuperAgent] Failed to discover agents:', err)
    }
  },
}))
