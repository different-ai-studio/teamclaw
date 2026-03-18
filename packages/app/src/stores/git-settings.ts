import { create } from 'zustand'
import { GitStatus } from '@/lib/git/service'
import { loadFromStorage, saveToStorage } from '@/lib/storage'

// Default color scheme for Git statuses
const DEFAULT_STATUS_COLORS: Record<GitStatus, string> = {
  [GitStatus.MODIFIED]: 'text-yellow-500',
  [GitStatus.ADDED]: 'text-green-500',
  [GitStatus.DELETED]: 'text-red-500',
  [GitStatus.UNTRACKED]: 'text-gray-400',
  [GitStatus.STAGED]: 'text-blue-500',
  [GitStatus.RENAMED]: 'text-purple-500',
  [GitStatus.COPIED]: 'text-cyan-500',
  [GitStatus.IGNORED]: 'text-muted-foreground',
}

// Storage key for persisting settings
const STORAGE_KEY = 'teamclaw-git-settings'

interface GitSettingsState {
  /** Whether to show Git status indicators in the file tree */
  showGitStatus: boolean
  /** Whether to show status icons (color-blind friendly mode) */
  showStatusIcons: boolean
  /** Custom color overrides per Git status */
  statusColors: Record<GitStatus, string>
  /** Polling interval in milliseconds */
  pollingInterval: number

  // Actions
  setShowGitStatus: (show: boolean) => void
  setShowStatusIcons: (show: boolean) => void
  setStatusColor: (status: GitStatus, color: string) => void
  resetStatusColors: () => void
  setPollingInterval: (interval: number) => void
}

function loadPersistedSettings(): Partial<GitSettingsState> {
  return loadFromStorage<Partial<GitSettingsState>>(STORAGE_KEY, {})
}

function persistSettings(state: Partial<GitSettingsState>) {
  saveToStorage(STORAGE_KEY, {
    showGitStatus: state.showGitStatus,
    showStatusIcons: state.showStatusIcons,
    statusColors: state.statusColors,
    pollingInterval: state.pollingInterval,
  })
}

const persisted = loadPersistedSettings()

export const useGitSettingsStore = create<GitSettingsState>((set, get) => ({
  showGitStatus: persisted.showGitStatus ?? true,
  showStatusIcons: persisted.showStatusIcons ?? true,
  statusColors: persisted.statusColors ?? { ...DEFAULT_STATUS_COLORS },
  pollingInterval: persisted.pollingInterval ?? 30000,

  setShowGitStatus: (show) => {
    set({ showGitStatus: show })
    persistSettings(get())
  },

  setShowStatusIcons: (show) => {
    set({ showStatusIcons: show })
    persistSettings(get())
  },

  setStatusColor: (status, color) => {
    const current = get().statusColors
    const updated = { ...current, [status]: color }
    set({ statusColors: updated })
    persistSettings(get())
  },

  resetStatusColors: () => {
    set({ statusColors: { ...DEFAULT_STATUS_COLORS } })
    persistSettings(get())
  },

  setPollingInterval: (interval) => {
    set({ pollingInterval: interval })
    persistSettings(get())
  },
}))

export { DEFAULT_STATUS_COLORS }
