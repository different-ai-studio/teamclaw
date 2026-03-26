import { create } from 'zustand'

export interface FileVersion {
  index: number
  content: string
  hash: string
  updatedBy: string
  updatedAt: string
  deleted: boolean
}

export interface VersionedFileInfo {
  path: string
  docType: string
  versionCount: number
  latestUpdateBy: string
  latestUpdateAt: string
  currentDeleted: boolean
}

interface VersionHistoryState {
  // State
  versionedFiles: VersionedFileInfo[]
  fileVersions: FileVersion[]
  selectedFile: { path: string; docType: string } | null
  selectedVersionIndex: number | null
  loading: boolean
  error: string | null

  // Actions
  loadVersionedFiles: (workspacePath: string, docType?: string) => Promise<void>
  loadFileVersions: (workspacePath: string, docType: string, filePath: string) => Promise<void>
  restoreFileVersion: (workspacePath: string, docType: string, filePath: string, versionIndex: number) => Promise<void>
  selectFile: (path: string, docType: string) => void
  selectVersion: (index: number | null) => void
  reset: () => void
}

export const useVersionHistoryStore = create<VersionHistoryState>((set) => ({
  // Initial state
  versionedFiles: [],
  fileVersions: [],
  selectedFile: null,
  selectedVersionIndex: null,
  loading: false,
  error: null,

  loadVersionedFiles: async (workspacePath, docType) => {
    set({ loading: true, error: null })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const files = await invoke<VersionedFileInfo[]>('team_list_all_versioned_files', {
        workspacePath,
        docType: docType ?? null,
      })
      set({ versionedFiles: files, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  loadFileVersions: async (workspacePath, docType, filePath) => {
    set({ loading: true, error: null })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const versions = await invoke<FileVersion[]>('team_list_file_versions', {
        workspacePath,
        docType,
        filePath,
      })
      set({ fileVersions: versions, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  restoreFileVersion: async (workspacePath, docType, filePath, versionIndex) => {
    set({ loading: true, error: null })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('team_restore_file_version', {
        workspacePath,
        docType,
        filePath,
        versionIndex,
      })
      set({ loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
      throw e
    }
  },

  selectFile: (path, docType) => {
    set({ selectedFile: { path, docType }, selectedVersionIndex: null, fileVersions: [] })
  },

  selectVersion: (index) => {
    set({ selectedVersionIndex: index })
  },

  reset: () => {
    set({
      versionedFiles: [],
      fileVersions: [],
      selectedFile: null,
      selectedVersionIndex: null,
      loading: false,
      error: null,
    })
  },
}))
