import { create } from 'zustand'

export interface FileVersion {
  ref: string
  author: string | null
  timestamp: string
  deleted: boolean
  message: string | null
}

export interface VersionedFileInfo {
  path: string
  status: string // "modified" | "added" | "deleted" | "renamed"
}

interface VersionHistoryState {
  versionedFiles: VersionedFileInfo[]
  fileVersions: FileVersion[]
  selectedFile: { path: string } | null
  selectedRef: string | null
  loading: boolean
  error: string | null

  loadVersionedFiles: (teamId: string) => Promise<void>
  loadFileVersions: (teamId: string, filePath: string) => Promise<void>
  fetchVersionContent: (teamId: string, filePath: string, ref: string) => Promise<string | null>
  restoreFileVersion: (teamId: string, filePath: string, ref: string) => Promise<void>
  selectFile: (path: string) => void
  selectVersion: (ref: string | null) => void
  reset: () => void
}

export const useVersionHistoryStore = create<VersionHistoryState>((set) => ({
  versionedFiles: [],
  fileVersions: [],
  selectedFile: null,
  selectedRef: null,
  loading: false,
  error: null,

  loadVersionedFiles: async (teamId) => {
    set({ loading: true, error: null })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<{ files: VersionedFileInfo[] }>('team_changed_files', { teamId })
      set({ versionedFiles: res.files ?? [], loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  loadFileVersions: async (teamId, filePath) => {
    set({ loading: true, error: null })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<{ versions: FileVersion[] }>('team_file_versions', {
        teamId,
        path: filePath,
      })
      set({ fileVersions: res.versions ?? [], loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  fetchVersionContent: async (teamId, filePath, ref) => {
    const { invoke } = await import('@tauri-apps/api/core')
    const res = await invoke<{ content: string | null }>('team_file_content', {
      teamId,
      path: filePath,
      ref,
    })
    return res.content ?? null
  },

  restoreFileVersion: async (teamId, filePath, ref) => {
    set({ loading: true, error: null })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('team_restore_file_version', { teamId, path: filePath, ref })
      set({ loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
      throw e
    }
  },

  selectFile: (path) => set({ selectedFile: { path }, selectedRef: null, fileVersions: [] }),
  selectVersion: (ref) => set({ selectedRef: ref }),
  reset: () =>
    set({
      versionedFiles: [],
      fileVersions: [],
      selectedFile: null,
      selectedRef: null,
      loading: false,
      error: null,
    }),
}))
