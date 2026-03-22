import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

interface OssTeamInfo {
  teamId: string
  teamSecret?: string
  teamName: string
  ownerName: string
  role: string
}

interface SyncStatus {
  connected: boolean
  syncing: boolean
  lastSyncAt: string | null
  nextSyncAt: string | null
  docs: Record<string, DocSyncStatus>
}

interface DocSyncStatus {
  localVersion: number
  remoteUpdateCount: number
  lastUploadAt: string | null
  lastDownloadAt: string | null
}

interface CleanupResult {
  deletedCount: number
  freedBytes: number
}

interface TeamMember {
  nodeId: string
  name: string
  role: string
  joinedAt: string
}

interface OssTeamConfig {
  enabled: boolean
  teamId: string
  fcEndpoint: string
  lastSyncAt: string | null
  pollIntervalSecs: number
}

interface TeamOssState {
  // State
  connected: boolean
  syncing: boolean
  syncStatus: SyncStatus | null
  teamInfo: OssTeamInfo | null
  members: TeamMember[]
  error: string | null
  _unlisten: UnlistenFn | null

  // Actions
  initialize: (workspacePath: string) => Promise<void>
  createTeam: (params: {
    workspacePath: string
    teamName: string
    ownerName: string
    ownerEmail: string
  }) => Promise<OssTeamInfo>
  joinTeam: (params: {
    workspacePath: string
    teamId: string
    teamSecret: string
  }) => Promise<OssTeamInfo>
  leaveTeam: (workspacePath: string) => Promise<void>
  syncNow: (workspacePath: string) => Promise<void>
  loadSyncStatus: (workspacePath: string) => Promise<void>
  createSnapshot: (workspacePath: string, docType: string) => Promise<void>
  cleanupUpdates: (workspacePath: string, docType: string) => Promise<CleanupResult>
  updateMembers: (workspacePath: string, members: TeamMember[]) => Promise<void>
  resetTeamSecret: (workspacePath: string) => Promise<string>
  cleanup: () => void
}

export const useTeamOssStore = create<TeamOssState>((set, get) => ({
  // initial state
  connected: false,
  syncing: false,
  syncStatus: null,
  teamInfo: null,
  members: [],
  error: null,
  _unlisten: null,

  initialize: async (workspacePath) => {
    try {
      // Listen for sync status events from Rust backend
      const unlisten = await listen<SyncStatus>('oss-sync-status', (event) => {
        set({
          syncStatus: event.payload,
          connected: event.payload.connected,
          syncing: event.payload.syncing,
        })
      })
      set({ _unlisten: unlisten })

      const config = await invoke<OssTeamConfig | null>('oss_get_team_config', { workspacePath })
      if (config?.enabled) {
        const info = await invoke<OssTeamInfo>('oss_restore_sync', {
          workspacePath,
          teamId: config.teamId,
        })
        set({ connected: true, teamInfo: info })
      }
    } catch (e) {
      console.error('OSS sync init failed:', e)
      set({ error: String(e) })
    }
  },

  createTeam: async (params) => {
    const info = await invoke<OssTeamInfo>('oss_create_team', params)
    set({ connected: true, teamInfo: info, error: null })
    return info
  },

  joinTeam: async (params) => {
    const info = await invoke<OssTeamInfo>('oss_join_team', params)
    set({ connected: true, teamInfo: info, error: null })
    return info
  },

  leaveTeam: async (workspacePath) => {
    await invoke('oss_leave_team', { workspacePath })
    set({
      connected: false,
      teamInfo: null,
      syncStatus: null,
      members: [],
      error: null,
    })
  },

  syncNow: async (workspacePath) => {
    set({ syncing: true })
    try {
      const status = await invoke<SyncStatus>('oss_sync_now', { workspacePath })
      set({ syncStatus: status, syncing: false })
    } catch (e) {
      set({ syncing: false, error: String(e) })
    }
  },

  loadSyncStatus: async (workspacePath) => {
    try {
      const status = await invoke<SyncStatus>('oss_get_sync_status', { workspacePath })
      set({ syncStatus: status, connected: status.connected })
    } catch (e) {
      set({ error: String(e) })
    }
  },

  createSnapshot: async (workspacePath, docType) => {
    await invoke('oss_create_snapshot', { workspacePath, docType })
  },

  cleanupUpdates: async (workspacePath, docType) => {
    return await invoke<CleanupResult>('oss_cleanup_updates', { workspacePath, docType })
  },

  updateMembers: async (workspacePath, members) => {
    await invoke('oss_update_members', { workspacePath, members })
    set({ members })
  },

  resetTeamSecret: async (workspacePath) => {
    return await invoke<string>('oss_reset_team_secret', { workspacePath })
  },

  cleanup: () => {
    const { _unlisten } = get()
    if (_unlisten) {
      _unlisten()
      set({ _unlisten: null })
    }
  },
}))
