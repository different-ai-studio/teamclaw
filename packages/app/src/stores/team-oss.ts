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
  lastDataSyncAt: string | null
  lastCheckAt: string | null
  nextSyncAt: string | null
  health: 'healthy' | 'warning' | 'error' | 'offline'
  healthMessage: string | null
  skippedFiles: Array<{ path: string; reason: string }>
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
  teamEndpoint: string
  forcePathStyle: boolean
  lastDataSyncAt: string | null
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
  teamEndpoint: string
  appliedAt: string
}

interface FileSyncStatus {
  path: string
  docType: string
  status: 'synced' | 'modified' | 'new'
}

interface TeamOssState {
  // State
  configured: boolean // local config exists (oss.enabled), true even when offline
  connected: boolean
  restoring: boolean // true while oss_restore_sync is in progress on startup
  syncing: boolean
  syncStatus: SyncStatus | null
  syncProgress: { phase: string; docType: string; current?: number; total?: number } | null
  teamInfo: OssTeamInfo | null
  members: TeamMember[]
  error: string | null
  _unlisten: UnlistenFn | null
  pendingApplication: PendingApplication | null
  fileSyncStatusMap: Record<string, 'synced' | 'modified' | 'new'>

  // Actions
  initialize: (workspacePath: string) => Promise<void>
  createTeam: (params: {
    workspacePath: string
    teamName: string
    ownerName: string
    ownerEmail: string
    fcEndpoint: string
    llmBaseUrl?: string
    llmModel?: string
    llmModelName?: string
  }) => Promise<OssTeamInfo>
  joinTeam: (params: {
    workspacePath: string
    teamId: string
    teamSecret: string
    fcEndpoint: string
    llmBaseUrl?: string
    llmModel?: string
    llmModelName?: string
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
    fcEndpoint: string
    name: string
    email: string
    note: string
  }) => Promise<void>
  updateServiceConfig: (params: {
    workspacePath: string
    teamEndpoint?: string
    llmBaseUrl?: string
    llmModel?: string
    llmModelName?: string
  }) => Promise<void>
  reconnect: (workspacePath: string) => Promise<void>
  resetSync: (workspacePath: string) => Promise<void>
  loadPendingApplication: (workspacePath: string) => Promise<void>
  cancelApplication: (workspacePath: string) => Promise<void>
  cleanup: () => void
  loadFileSyncStatus: () => Promise<void>
}

export const useTeamOssStore = create<TeamOssState>((set, get) => ({
  // initial state
  configured: false,
  connected: false,
  restoring: false,
  syncing: false,
  syncStatus: null,
  syncProgress: null,
  teamInfo: null,
  members: [],
  error: null,
  _unlisten: null,
  pendingApplication: null,
  fileSyncStatusMap: {},

  initialize: async (workspacePath) => {
    try {
      // Listen for sync status events from Rust backend
      const unlistenSync = await listen<SyncStatus>('oss-sync-status', (event) => {
        set({
          syncStatus: event.payload,
          connected: event.payload.connected,
          syncing: event.payload.syncing,
        })
        // Refresh per-file sync status after each sync cycle
        if (!event.payload.syncing) {
          get().loadFileSyncStatus()
        }
      })

      const unlistenProgress = await listen<{ phase: string; docType: string; current?: number; total?: number }>('sync-progress', (event) => {
        set({ syncProgress: event.payload })
      })

      // Refresh per-file sync status when teamclaw-team/ files change locally,
      // so the "modified" (orange) state is visible before the next sync poll.
      let fileChangeTimer: ReturnType<typeof setTimeout> | null = null
      const unlistenFileChange = await listen<{ path: string; kind: string }>('file-change', (event) => {
        if (!event.payload.path.includes('teamclaw-team/')) return
        if (fileChangeTimer) clearTimeout(fileChangeTimer)
        fileChangeTimer = setTimeout(() => {
          get().loadFileSyncStatus()
        }, 1500)
      })

      set({
        _unlisten: () => {
          unlistenSync()
          unlistenProgress()
          unlistenFileChange()
          if (fileChangeTimer) clearTimeout(fileChangeTimer)
        },
      })

      const config = await invoke<OssTeamConfig | null>('oss_get_team_config', { workspacePath })
      if (config?.enabled) {
        set({ configured: true, restoring: true })
        try {
          // Safety timeout: if backend hangs (e.g. unreachable S3), stop the
          // spinner so the user can still interact with the UI.
          const RESTORE_TIMEOUT_MS = 120_000
          const info = await Promise.race([
            invoke<OssTeamInfo>('oss_restore_sync', {
              workspacePath,
              teamId: config.teamId,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('OSS restore timed out')), RESTORE_TIMEOUT_MS),
            ),
          ])
          set({ connected: true, teamInfo: info, restoring: false })
        } catch (e) {
          // Offline or restore failed — still configured, just not connected
          console.warn('OSS restore failed (offline?):', e)
          set({ restoring: false, error: String(e) })
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

  reconnect: async (workspacePath) => {
    set({ restoring: true, error: null })
    try {
      const config = await invoke<OssTeamConfig | null>('oss_get_team_config', { workspacePath })
      if (!config?.enabled) {
        set({ restoring: false, configured: false })
        return
      }
      const RESTORE_TIMEOUT_MS = 120_000
      const info = await Promise.race([
        invoke<OssTeamInfo>('oss_restore_sync', {
          workspacePath,
          teamId: config.teamId,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('OSS restore timed out')), RESTORE_TIMEOUT_MS),
        ),
      ])
      set({ connected: true, teamInfo: info, restoring: false })
    } catch (e) {
      console.warn('OSS reconnect failed:', e)
      set({ restoring: false, error: String(e) })
    }
  },

  createTeam: async (params) => {
    try {
      const info = await invoke<OssTeamInfo>('oss_create_team', {
        workspacePath: params.workspacePath,
        teamName: params.teamName,
        ownerName: params.ownerName,
        ownerEmail: params.ownerEmail,
        teamEndpoint: params.fcEndpoint,
        forcePathStyle: buildConfig.s3?.forcePathStyle ?? false,
        llmBaseUrl: params.llmBaseUrl || null,
        llmModel: params.llmModel || null,
        llmModelName: params.llmModelName || null,
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
        workspacePath: params.workspacePath,
        teamId: params.teamId,
        teamSecret: params.teamSecret,
        teamEndpoint: params.fcEndpoint,
        forcePathStyle: buildConfig.s3?.forcePathStyle ?? false,
        llmBaseUrl: params.llmBaseUrl || null,
        llmModel: params.llmModel || null,
        llmModelName: params.llmModelName || null,
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

  resetSync: async (workspacePath) => {
    set({ syncing: true })
    try {
      const status = await invoke<SyncStatus>('oss_reset_sync', { workspacePath })
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

  updateServiceConfig: async (params) => {
    try {
      await invoke('oss_update_service_config', {
        workspacePath: params.workspacePath,
        teamEndpoint: params.teamEndpoint || null,
        llmBaseUrl: params.llmBaseUrl || null,
        llmModel: params.llmModel || null,
        llmModelName: params.llmModelName || null,
      })
      set({ error: null })
    } catch (e) {
      set({ error: String(e) })
      throw e
    }
  },

  applyToTeam: async (params) => {
    try {
      await invoke('oss_apply_team', {
        workspacePath: params.workspacePath,
        teamId: params.teamId,
        teamSecret: params.teamSecret,
        name: params.name,
        email: params.email,
        note: params.note,
        teamEndpoint: params.fcEndpoint,
        forcePathStyle: buildConfig.s3?.forcePathStyle ?? false,
      })
      const pending: PendingApplication = {
        teamId: params.teamId,
        teamEndpoint: params.fcEndpoint,
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
    }
    set({
      _unlisten: null,
      configured: false,
      connected: false,
      restoring: false,
      syncing: false,
      syncStatus: null,
      syncProgress: null,
      teamInfo: null,
      members: [],
      error: null,
      pendingApplication: null,
      fileSyncStatusMap: {},
    })
  },

  loadFileSyncStatus: async () => {
    try {
      const statuses = await invoke<FileSyncStatus[]>('oss_get_files_sync_status', {})
      const map: Record<string, 'synced' | 'modified' | 'new'> = {}
      for (const s of statuses) {
        map[s.path] = s.status
      }
      set({ fileSyncStatusMap: map })
    } catch (e) {
      console.debug('[team-oss] loadFileSyncStatus skipped:', e)
    }
  },
}))
