import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { buildConfig } from '@/lib/build-config'

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

interface OssJoinResult {
  status: 'joined' | 'not_member'
  // When status === 'joined', all OssTeamInfo fields are present
  teamId?: string
  teamSecret?: string
  teamName?: string
  ownerName?: string
  role?: string
  // When status === 'not_member'
  nodeId?: string
}

interface PendingApplication {
  teamId: string
  fcEndpoint: string
  appliedAt: string
}

interface TeamOssState {
  // State
  configured: boolean // local config exists (oss.enabled), true even when offline
  connected: boolean
  syncing: boolean
  syncStatus: SyncStatus | null
  teamInfo: OssTeamInfo | null
  members: TeamMember[]
  error: string | null
  _unlisten: UnlistenFn | null
  pendingApplication: PendingApplication | null

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
  }) => Promise<OssJoinResult>
  leaveTeam: (workspacePath: string) => Promise<void>
  syncNow: (workspacePath: string) => Promise<void>
  loadSyncStatus: (workspacePath: string) => Promise<void>
  createSnapshot: (workspacePath: string, docType: string) => Promise<void>
  cleanupUpdates: (workspacePath: string, docType: string) => Promise<CleanupResult>
  updateMembers: (workspacePath: string, members: TeamMember[]) => Promise<void>
  resetTeamSecret: (workspacePath: string) => Promise<string>
  applyToTeam: (params: {
    workspacePath: string
    teamId: string
    teamSecret: string
    name: string
    email: string
    note: string
  }) => Promise<void>
  loadPendingApplication: (workspacePath: string) => Promise<void>
  cancelApplication: (workspacePath: string) => Promise<void>
  cleanup: () => void
}

export const useTeamOssStore = create<TeamOssState>((set, get) => ({
  // initial state
  configured: false,
  connected: false,
  syncing: false,
  syncStatus: null,
  teamInfo: null,
  members: [],
  error: null,
  _unlisten: null,
  pendingApplication: null,

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
        set({ configured: true })
        try {
          const info = await invoke<OssTeamInfo>('oss_restore_sync', {
            workspacePath,
            teamId: config.teamId,
          })
          set({ connected: true, teamInfo: info })
        } catch (e) {
          // Offline or restore failed — still configured, just not connected
          console.warn('OSS restore failed (offline?):', e)
        }
      } else {
        // Check for pending application
        const pending = await invoke<PendingApplication | null>('oss_get_pending_application', { workspacePath })
        if (pending) {
          set({ pendingApplication: pending })
        }
      }
    } catch (e) {
      console.error('OSS sync init failed:', e)
      set({ error: String(e) })
    }
  },

  createTeam: async (params) => {
    try {
      const info = await invoke<OssTeamInfo>('oss_create_team', {
        ...params,
        fcEndpoint: buildConfig.oss?.fcEndpoint ?? '',
      })
      set({ configured: true, connected: true, teamInfo: info, error: null })
      // Refresh file tree so the new teamclaw-team directory appears
      const { useWorkspaceStore } = await import('@/stores/workspace')
      await useWorkspaceStore.getState().refreshFileTree()
      return info
    } catch (e) {
      set({ error: String(e) })
      throw e
    }
  },

  joinTeam: async (params) => {
    try {
      const result = await invoke<OssJoinResult>('oss_join_team', {
        ...params,
        fcEndpoint: buildConfig.oss?.fcEndpoint ?? '',
      })

      if (result.status === 'not_member') {
        // Not a member — return result so UI can open application dialog
        return result
      }

      // Joined successfully
      const info: OssTeamInfo = {
        teamId: result.teamId!,
        teamSecret: result.teamSecret,
        teamName: result.teamName!,
        ownerName: result.ownerName!,
        role: result.role!,
      }
      set({ configured: true, connected: true, teamInfo: info, error: null, pendingApplication: null })
      const { useWorkspaceStore } = await import('@/stores/workspace')
      await useWorkspaceStore.getState().refreshFileTree()
      return result
    } catch (e) {
      set({ error: String(e) })
      throw e
    }
  },

  leaveTeam: async (workspacePath) => {
    try {
      await invoke('oss_leave_team', { workspacePath })
      set({
        configured: false,
        connected: false,
        teamInfo: null,
        syncStatus: null,
        members: [],
        error: null,
      })
    } catch (e) {
      set({ error: String(e) })
      throw e
    }
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

  applyToTeam: async (params) => {
    try {
      await invoke('oss_apply_team', {
        ...params,
        fcEndpoint: buildConfig.oss?.fcEndpoint ?? '',
      })
      const pending: PendingApplication = {
        teamId: params.teamId,
        fcEndpoint: buildConfig.oss?.fcEndpoint ?? '',
        appliedAt: new Date().toISOString(),
      }
      set({ pendingApplication: pending, error: null })
    } catch (e) {
      set({ error: String(e) })
      throw e
    }
  },

  loadPendingApplication: async (workspacePath) => {
    try {
      const pending = await invoke<PendingApplication | null>('oss_get_pending_application', { workspacePath })
      set({ pendingApplication: pending })
    } catch {
      // ignore
    }
  },

  cancelApplication: async (workspacePath) => {
    try {
      await invoke('oss_cancel_application', { workspacePath })
      set({ pendingApplication: null })
    } catch (e) {
      set({ error: String(e) })
    }
  },

  cleanup: () => {
    const { _unlisten } = get()
    if (_unlisten) {
      _unlisten()
      set({ _unlisten: null })
    }
  },
}))
