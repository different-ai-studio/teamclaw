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

export interface VersionHistoryProvider {
  listFiles: (workspacePath: string, docType?: string) => Promise<VersionedFileInfo[]>
  listVersions: (workspacePath: string, docType: string, filePath: string) => Promise<FileVersion[]>
  restore: (workspacePath: string, docType: string, filePath: string, versionIndex: number) => Promise<void>
}

let versionProvider: VersionHistoryProvider | null = null

export function registerVersionHistoryProvider(provider: VersionHistoryProvider) {
  versionProvider = provider
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
    if (!versionProvider) return
    set({ loading: true, error: null })
    try {
      const files = await versionProvider.listFiles(workspacePath, docType)
      set({ versionedFiles: files, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  loadFileVersions: async (workspacePath, docType, filePath) => {
    if (!versionProvider) return
    set({ loading: true, error: null })
    try {
      const versions = await versionProvider.listVersions(workspacePath, docType, filePath)
      set({ fileVersions: versions, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  restoreFileVersion: async (workspacePath, docType, filePath, versionIndex) => {
    if (!versionProvider) return
    set({ loading: true, error: null })
    try {
      await versionProvider.restore(workspacePath, docType, filePath, versionIndex)
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
