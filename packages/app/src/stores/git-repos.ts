import { create } from 'zustand'
import type { GitRepo, GitRepoConfig, RepoSyncStatus } from '@/lib/git/types'
import { gitManager } from '@/lib/git/manager'
import { useWorkspaceStore } from '@/stores/workspace'
import { loadFromStorage, saveToStorage } from '@/lib/storage'
import { appShortName } from '@/lib/build-config'

// Storage key for persisting repo state
const STORAGE_KEY = `${appShortName}-git-repos`

interface GitReposState {
  /** Whether git CLI is available on the system */
  gitAvailable: boolean | null
  /** Git version string */
  gitVersion: string | null
  /** List of managed repositories */
  repos: GitRepo[]
  /** Git repo configuration (URLs) */
  config: GitRepoConfig
  /** Whether initial check has been performed */
  initialized: boolean
  /** Whether a global sync is in progress */
  syncing: boolean

  // Actions
  initialize: () => Promise<void>
  refreshRepos: () => Promise<void>
  syncAll: () => Promise<void>
  syncRepo: (repoId: string) => Promise<void>
  updateRepoStatus: (repoId: string, status: RepoSyncStatus, error?: string) => void
  setConfig: (config: GitRepoConfig) => Promise<void>
  setPersonalSkillsUrl: (url: string) => Promise<void>
  setPersonalDocumentsUrl: (url: string) => Promise<void>
  setTeamRepoUrl: (type: 'skills' | 'documents', url: string) => Promise<void>
}

function loadPersistedState(): Partial<{ gitAvailable: boolean; gitVersion: string }> {
  return loadFromStorage<Partial<{ gitAvailable: boolean; gitVersion: string }>>(STORAGE_KEY, {})
}

function persistState(data: { gitAvailable: boolean | null; gitVersion: string | null }) {
  saveToStorage(STORAGE_KEY, data)
}

export const useGitReposStore = create<GitReposState>((set, get) => ({
  gitAvailable: loadPersistedState().gitAvailable ?? null,
  gitVersion: loadPersistedState().gitVersion ?? null,
  repos: [],
  config: {},
  initialized: false,
  syncing: false,

  initialize: async () => {
    if (get().initialized) return

    // Check git availability
    const { available, version } = await gitManager.checkGitAvailable()
    set({ gitAvailable: available, gitVersion: version })
    persistState({ gitAvailable: available, gitVersion: version })

    if (!available) {
      set({ initialized: true })
      return
    }

    // Ensure directory structure
    await gitManager.ensureDirectoryStructure()

    // Load config and build repo list
    const workspacePath = useWorkspaceStore.getState().workspacePath ?? undefined
    const config = await gitManager.loadConfig()
    const repos = await gitManager.buildRepoList(workspacePath)
    set({ config, repos, initialized: true })
  },

  refreshRepos: async () => {
    const workspacePath = useWorkspaceStore.getState().workspacePath ?? undefined
    const repos = await gitManager.buildRepoList(workspacePath)
    set({ repos })
  },

  syncAll: async () => {
    const state = get()
    if (!state.gitAvailable || state.syncing) return

    set({ syncing: true })

    const workspacePath = useWorkspaceStore.getState().workspacePath ?? undefined
    await gitManager.syncAll(workspacePath, (repoId, status, error) => {
      get().updateRepoStatus(repoId, status, error)
    })

    // Refresh repo list to update isCloned status
    await get().refreshRepos()
    set({ syncing: false })
  },

  syncRepo: async (repoId: string) => {
    const repo = get().repos.find(r => r.id === repoId)
    if (!repo) return

    get().updateRepoStatus(repoId, 'syncing')

    try {
      await gitManager.cloneOrPull(repo.url, repo.localPath)
      get().updateRepoStatus(repoId, 'synced')
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      get().updateRepoStatus(repoId, 'error', errMsg)
    }

    // Refresh to update isCloned
    await get().refreshRepos()
  },

  updateRepoStatus: (repoId, status, error) => {
    set(state => ({
      repos: state.repos.map(r =>
        r.id === repoId
          ? {
              ...r,
              syncStatus: status,
              lastSyncAt: status === 'synced' ? new Date().toISOString() : r.lastSyncAt,
              lastError: error || (status === 'error' ? r.lastError : undefined),
            }
          : r
      ),
    }))
  },

  setConfig: async (config) => {
    await gitManager.saveConfig(config)
    set({ config })
    await get().refreshRepos()
  },

  setPersonalSkillsUrl: async (url) => {
    const config = { ...get().config, personalSkillsUrl: url }
    await get().setConfig(config)
  },

  setPersonalDocumentsUrl: async (url) => {
    const config = { ...get().config, personalDocumentsUrl: url }
    await get().setConfig(config)
  },

  setTeamRepoUrl: async (type, url) => {
    const config = { ...get().config }
    if (!config.team) config.team = {}
    if (type === 'skills') {
      config.team.skillsUrl = url
    } else {
      config.team.documentsUrl = url
    }
    await get().setConfig(config)
  },
}))
