import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { withAsync } from '@/lib/store-utils'

/** Environment variable entry (key + description, no secret value). */
export interface EnvVarEntry {
  key: string
  description?: string
  category?: 'system' | null
}

interface EnvVarsState {
  envVars: EnvVarEntry[]
  isLoading: boolean
  error: string | null
  hasChanges: boolean  // Track if env vars changed and OpenCode needs restart

  // Actions
  loadEnvVars: () => Promise<void>
  setEnvVar: (key: string, value: string, description?: string) => Promise<void>
  deleteEnvVar: (key: string) => Promise<void>
  getEnvVarValue: (key: string) => Promise<string>
  clearError: () => void
  setHasChanges: (hasChanges: boolean) => void
}

export const useEnvVarsStore = create<EnvVarsState>((set) => ({
  envVars: [],
  isLoading: false,
  error: null,
  hasChanges: false,

  loadEnvVars: async () => {
    await withAsync(set, async () => {
      const envVars = await invoke<EnvVarEntry[]>('env_var_list')
      set({ envVars })
    })
  },

  setEnvVar: async (key: string, value: string, description?: string) => {
    await withAsync(set, async () => {
      await invoke('env_var_set', { key, value, description })
      // Reload the list after setting
      const envVars = await invoke<EnvVarEntry[]>('env_var_list')
      set({ envVars, hasChanges: true })
    }, { rethrow: true })
  },

  deleteEnvVar: async (key: string) => {
    await withAsync(set, async () => {
      await invoke('env_var_delete', { key })
      const envVars = await invoke<EnvVarEntry[]>('env_var_list')
      set({ envVars, hasChanges: true })
    }, { rethrow: true })
  },

  getEnvVarValue: async (key: string) => {
    const value = await invoke<string>('env_var_get', { key })
    return value
  },

  clearError: () => set({ error: null }),

  setHasChanges: (hasChanges: boolean) => set({ hasChanges }),
}))
