import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { withAsync } from '@/lib/store-utils'

export interface SecretMeta {
  keyId: string
  description: string
  category: string
  createdBy: string
  updatedBy: string
  updatedAt: string
}

interface SharedSecretsState {
  secrets: SecretMeta[]
  isLoading: boolean
  error: string | null

  loadSecrets: () => Promise<void>
  setSecret: (keyId: string, value: string, description: string, category: string, nodeId: string) => Promise<void>
  deleteSecret: (keyId: string, nodeId: string, role: string) => Promise<void>
  clearError: () => void
  listenForChanges: () => Promise<() => void>
}

export const useSharedSecretsStore = create<SharedSecretsState>((set) => ({
  secrets: [],
  isLoading: false,
  error: null,

  loadSecrets: async () => {
    await withAsync(set, async () => {
      const secrets = await invoke<SecretMeta[]>('shared_secret_list')
      set({ secrets })
    })
  },

  setSecret: async (keyId: string, value: string, description: string, category: string, nodeId: string) => {
    await withAsync(set, async () => {
      await invoke('shared_secret_set', { keyId, value, description, category, nodeId })
      const secrets = await invoke<SecretMeta[]>('shared_secret_list')
      set({ secrets })
    }, { rethrow: true })
  },

  deleteSecret: async (keyId: string, nodeId: string, role: string) => {
    await withAsync(set, async () => {
      await invoke('shared_secret_delete', { keyId, nodeId, role })
      // Mark deletion in CRDT so sync doesn't recreate the file
      invoke('oss_mark_file_deleted', {
        docType: 'secrets',
        path: `${keyId}.enc.json`,
      }).catch(() => {}) // best-effort
      const secrets = await invoke<SecretMeta[]>('shared_secret_list')
      set({ secrets })
    }, { rethrow: true })
  },

  clearError: () => set({ error: null }),

  listenForChanges: async () => {
    const unlisten = await listen('secrets-changed', () => {
      invoke<SecretMeta[]>('shared_secret_list').then((secrets) => {
        set({ secrets })
      }).catch((e) => {
        console.error('shared-secrets: failed to reload on event:', e)
      })
    })
    return unlisten
  },
}))
