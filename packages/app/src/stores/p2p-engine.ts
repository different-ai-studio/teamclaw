import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import { useTeamModeStore } from './team-mode'

// Types must match Rust backend's EngineSnapshot exactly
export type PeerConnection = 'active' | 'stale' | 'lost' | 'unknown'
export type EngineStatus = 'connected' | 'disconnected' | 'reconnecting'
export type StreamHealth = 'healthy' | 'dead' | 'restarting'

export interface PeerInfo {
  nodeId: string
  name: string
  role: 'owner' | 'editor' | 'viewer'
  connection: PeerConnection
  lastSeenSecsAgo: number
  entriesSent: number
  entriesReceived: number
}

export interface EngineSnapshot {
  status: EngineStatus
  streamHealth: StreamHealth
  uptimeSecs: number
  restartCount: number
  lastSyncAt: string | null
  peers: PeerInfo[]
  syncedFiles: number
  pendingFiles: number
}

export const DEFAULT_SNAPSHOT: EngineSnapshot = {
  status: 'disconnected',
  streamHealth: 'dead',
  uptimeSecs: 0,
  restartCount: 0,
  lastSyncAt: null,
  peers: [],
  syncedFiles: 0,
  pendingFiles: 0,
}

interface P2pEngineState {
  snapshot: EngineSnapshot
  initialized: boolean
  init: () => Promise<() => void>
  fetch: () => Promise<void>
  reset: () => void
}

function isEngineSnapshot(value: unknown): value is EngineSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<EngineSnapshot>
  return (
    typeof candidate.status === 'string' &&
    typeof candidate.streamHealth === 'string' &&
    typeof candidate.uptimeSecs === 'number' &&
    typeof candidate.restartCount === 'number' &&
    Array.isArray(candidate.peers) &&
    typeof candidate.syncedFiles === 'number' &&
    typeof candidate.pendingFiles === 'number'
  )
}

export const useP2pEngineStore = create<P2pEngineState>((set, get) => ({
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

    const unlisten = await listen<EngineSnapshot>('p2p:engine-state', () => {
      void get().fetch()
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
      const snapshot = await invoke<EngineSnapshot | null>('p2p_node_status')
      if (isEngineSnapshot(snapshot)) {
        set({ snapshot })
      }
    } catch (err) {
      console.warn('[P2pEngine] Failed to fetch engine snapshot:', err)
    }
  },

  reset: () => {
    set({ snapshot: DEFAULT_SNAPSHOT, initialized: false })
  },
}))

// Sync p2pConnected to team-mode store so existing consumers keep working
useP2pEngineStore.subscribe((state) => {
  const connected = state.snapshot?.status === 'connected'
  if (useTeamModeStore.getState().p2pConnected !== connected) {
    useTeamModeStore.setState({ p2pConnected: connected })
  }
})
