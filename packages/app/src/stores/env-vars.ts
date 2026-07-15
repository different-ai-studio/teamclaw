import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { withAsync } from '@/lib/store-utils'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'

/** Environment variable entry (key + description, no secret value). */
export interface EnvVarEntry {
  key: string
  description?: string
  /**
   * `system`        — locally seeded by Rust on every launch (e.g. `tc_api_key`).
   * `system-shared` — registered by Rust on every launch but the value lives in
   *                   team `_secrets/`. Surfaced even when unset so the user is
   *                   reminded to fill it in.
   */
  category?: 'system' | 'system-shared' | null
}

/** Team secret metadata (no plaintext value). */
export interface TeamEnvListing {
  keyId: string
  description: string
  category: string
  createdBy: string
  updatedBy: string
  updatedAt: string
}

/** Unified catalog returned by `env_catalog_list`. */
export interface EnvCatalog {
  personal: EnvVarEntry[]
  team: TeamEnvListing[]
}

export type EnvScope = 'personal' | 'team'

interface EnvVarsState {
  envVars: EnvVarEntry[]
  teamSecrets: TeamEnvListing[]
  isLoading: boolean
  error: string | null
  hasChanges: boolean

  loadEnvCatalog: () => Promise<void>
  setCatalogEntry: (
    scope: EnvScope,
    key: string,
    value: string,
    options?: { description?: string; category?: string; nodeId?: string },
  ) => Promise<void>
  deleteCatalogEntry: (
    scope: EnvScope,
    key: string,
    options?: { nodeId?: string; role?: string },
  ) => Promise<void>
  getEnvVarValue: (key: string) => Promise<string>
  clearError: () => void
  setHasChanges: (hasChanges: boolean) => void
}

function requireWorkspacePath(): string {
  const workspacePath = useWorkspaceStore.getState().workspacePath
  if (!workspacePath) {
    throw new Error('No workspace selected')
  }
  return workspacePath
}

async function fetchEnvCatalog(): Promise<EnvCatalog> {
  return invoke<EnvCatalog>('env_catalog_list', {
    workspacePath: requireWorkspacePath(),
  })
}

export const useEnvVarsStore = create<EnvVarsState>((set) => ({
  envVars: [],
  teamSecrets: [],
  isLoading: false,
  error: null,
  hasChanges: false,

  loadEnvCatalog: async () => {
    await withAsync(set, async () => {
      const catalog = await fetchEnvCatalog()
      set({ envVars: catalog.personal, teamSecrets: catalog.team })
    })
  },

  setCatalogEntry: async (scope, key, value, options) => {
    await withAsync(set, async () => {
      await invoke('env_catalog_set', {
        scope,
        key,
        value,
        description: options?.description,
        category: options?.category,
        nodeId: options?.nodeId,
        teamId: useCurrentTeamStore.getState().team?.id,
        workspacePath: requireWorkspacePath(),
      })
      const catalog = await fetchEnvCatalog()
      set({ envVars: catalog.personal, teamSecrets: catalog.team, hasChanges: true })
    }, { rethrow: true })
  },

  deleteCatalogEntry: async (scope, key, options) => {
    await withAsync(set, async () => {
      await invoke('env_catalog_delete', {
        scope,
        key,
        nodeId: options?.nodeId,
        role: options?.role,
        teamId: useCurrentTeamStore.getState().team?.id,
        workspacePath: requireWorkspacePath(),
      })
      const catalog = await fetchEnvCatalog()
      set({ envVars: catalog.personal, teamSecrets: catalog.team, hasChanges: true })
    }, { rethrow: true })
  },

  getEnvVarValue: async (key: string) => {
    return invoke<string>('env_var_get', {
      key,
      workspacePath: requireWorkspacePath(),
    })
  },

  clearError: () => set({ error: null }),

  setHasChanges: (hasChanges: boolean) => set({ hasChanges }),
}))
