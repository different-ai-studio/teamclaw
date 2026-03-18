import { create } from 'zustand'
import { getOpenCodeClient } from '@/lib/opencode/client'
import { toast } from 'sonner'
import {
  type CustomProviderConfig,
  addCustomProviderToConfig,
  removeCustomProviderFromConfig,
  getCustomProviderIds,
} from '@/lib/opencode/config'

// Safe helper: returns client or null if not initialized yet
function tryGetClient() {
  try {
    return getOpenCodeClient()
  } catch {
    return null
  }
}

// A model option available for selection in the ChatPanel
export interface ModelOption {
  id: string
  name: string
  provider: string
}

// Provider entry for the Settings provider list
export interface ProviderEntry {
  id: string
  name: string
  configured: boolean // true if in the `connected` list
}

// Configured provider with full model info (from GET /config/providers)
export interface ConfiguredProvider {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
}

export interface ProviderState {
  // All available providers (from GET /provider), with configured status
  providers: ProviderEntry[]
  providersLoading: boolean

  // Configured providers with model details (from GET /config/providers)
  configuredProviders: ConfiguredProvider[]
  configuredProvidersLoading: boolean

  // Flattened model list built from configuredProviders
  models: ModelOption[]

  // Currently selected model (from GET /config)
  currentModelKey: string | null // format: "providerId/modelId"

  // Custom provider IDs (defined in opencode.json)
  customProviderIds: string[]

  // Provider IDs disconnected in the current session. OpenCode reports custom
  // providers (defined in opencode.json) as "connected" even after auth is
  // removed, so we track them here and filter during refreshes.
  _disconnectedIds: Set<string>

  // Actions
  refreshProviders: () => Promise<void>
  refreshConfiguredProviders: () => Promise<void>
  refreshCurrentModel: () => Promise<void>
  refreshCustomProviderIds: (workspacePath: string) => Promise<void>
  connectProvider: (providerId: string, apiKey: string) => Promise<boolean>
  disconnectProvider: (providerId: string) => Promise<boolean>
  addCustomProvider: (workspacePath: string, config: CustomProviderConfig, apiKey: string) => Promise<string | null>
  removeCustomProvider: (workspacePath: string, providerId: string) => Promise<boolean>
  selectModel: (providerId: string, modelId: string, modelName: string) => Promise<void>
  initAll: () => Promise<void>
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  // Initial state
  providers: [],
  providersLoading: false,
  configuredProviders: [],
  configuredProvidersLoading: false,
  models: [],
  currentModelKey: null,
  customProviderIds: [],
  _disconnectedIds: new Set<string>(),

  // Refresh all available providers (GET /provider)
  // Response: { all: ProviderObj[], connected: string[], default: Record<string,string> }
  refreshProviders: async () => {
    const client = tryGetClient()
    if (!client) return // Client not ready yet, skip silently
    set({ providersLoading: true })
    try {
      const data = await client.getProviders()
      const connectedSet = new Set(data.connected || [])
      const { _disconnectedIds } = get()
      _disconnectedIds.forEach((id) => connectedSet.delete(id))
      const providers: ProviderEntry[] = (data.all || []).map((p: any) => ({
        id: p.id,
        name: p.name || p.id,
        configured: connectedSet.has(p.id),
      }))
      // Sort: connected first, then alphabetical
      providers.sort((a, b) => {
        if (a.configured !== b.configured) return a.configured ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      set({ providers, providersLoading: false })
    } catch (err) {
      console.error('Failed to load providers:', err)
      toast.error('Failed to load providers', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      set({ providersLoading: false })
    }
  },

  // Refresh configured providers with model details (GET /config/providers)
  refreshConfiguredProviders: async () => {
    const client = tryGetClient()
    if (!client) return // Client not ready yet, skip silently
    set({ configuredProvidersLoading: true })
    try {
      const data = await client.getConfigProviders()
      const { _disconnectedIds } = get()

      // Transform providers into our format, excluding disconnected ones
      const configuredProviders: ConfiguredProvider[] = (data.providers || [])
        .filter((p: any) => !_disconnectedIds.has(p.id || p.name))
        .map((p: any) => ({
          id: p.id || p.name,
          name: p.name,
          models: Object.entries(p.models || {}).map(([key, model]: [string, any]) => ({
            id: model.id || key,
            name: model.name || key,
          })),
        }))

      // Build flattened models list
      const models: ModelOption[] = []
      configuredProviders.forEach((p) => {
        p.models.forEach((m) => {
          models.push({
            id: m.id,
            name: m.name,
            provider: p.id,
          })
        })
      })

      set({
        configuredProviders,
        models,
        configuredProvidersLoading: false,
      })
    } catch (err) {
      console.error('Failed to load configured providers:', err)
      toast.error('Failed to load model list', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      set({ configuredProvidersLoading: false })
    }
  },

  // Refresh current model from opencode config (GET /config)
  refreshCurrentModel: async () => {
    const client = tryGetClient()
    if (!client) return // Client not ready yet, skip silently
    try {
      const config = await client.getConfig()
      if (config.model) {
        set({ currentModelKey: config.model })
      }
    } catch (err) {
      console.error('Failed to load current model config:', err)
      // Non-critical, don't toast
    }
  },

  // Connect a provider by setting its API key and validate by fetching provider models.
  // Some providers (e.g. Alibaba Coding) may return models slowly or in a different shape;
  // we retry once and allow "provider found but 0 models" as success with a note.
  connectProvider: async (providerId: string, apiKey: string) => {
    const client = tryGetClient()
    if (!client) {
      toast.error('OpenCode not connected')
      return false
    }
    try {
      await client.setAuth(providerId, { type: 'api', key: apiKey })
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
      await delay(600)
      let data: { providers?: Array<{ id?: string; name?: string; models?: unknown }> } = {}
      for (let attempt = 0; attempt < 2; attempt++) {
        data = await client.getConfigProviders()
        const providers = data.providers || []
        const provider = providers.find(
          (p: { id?: string; name?: string }) =>
            (p.id && p.id === providerId) ||
            (p.name && p.name === providerId) ||
            (p.id && p.id.toLowerCase() === providerId.toLowerCase()) ||
            (p.name && p.name.toLowerCase() === providerId.toLowerCase())
        )
        if (provider) {
          const models = provider.models
          const modelCount =
            Array.isArray(models) ? models.length : typeof models === 'object' && models ? Object.keys(models).length : 0
          if (import.meta.env.DEV) {
            console.log('[LLM connect] providerId=', providerId, 'found=', true, 'modelCount=', modelCount)
          }
          if (modelCount > 0) {
            toast.success('Provider connected', {
              description: `Successfully connected ${providerId}`,
            })
          } else {
            toast.success('Provider connected', {
              description: 'If no models appear below, the provider may list them later or use a custom model ID.',
            })
          }
          set((state) => {
            const newDisconnected = new Set(state._disconnectedIds)
            newDisconnected.delete(providerId)
            return { _disconnectedIds: newDisconnected }
          })
          await Promise.all([
            get().refreshProviders(),
            get().refreshConfiguredProviders(),
          ])
          return true
        }
        if (attempt === 0) {
          await delay(800)
        }
      }
      const providers = data.providers || []
      console.warn('[LLM connect] Provider not in config list after setAuth (may be valid for some providers).', { providerId, providerIds: providers.map((p: { id?: string; name?: string }) => p.id || p.name) })
      toast.success('Provider connected', {
        description: 'If no models appear, select the model in chat or check the provider’s custom model ID.',
      })
      set((state) => {
        const newDisconnected = new Set(state._disconnectedIds)
        newDisconnected.delete(providerId)
        return { _disconnectedIds: newDisconnected }
      })
      await Promise.all([
        get().refreshProviders(),
        get().refreshConfiguredProviders(),
      ])
      return true
    } catch (err) {
      console.error('[LLM connect] Failed to connect provider:', err)
      toast.error('Failed to connect provider', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      return false
    }
  },

  // Disconnect a provider by removing its authentication
  disconnectProvider: async (providerId: string) => {
    const client = tryGetClient()
    if (!client) {
      toast.error('OpenCode not connected')
      return false
    }
    try {
      await client.deleteAuth(providerId)
      toast.success('Provider disconnected', {
        description: `Successfully disconnected ${providerId}`,
      })
      // Track as disconnected so subsequent refreshes from the server
      // don't re-add it as "connected" (OpenCode reports custom providers
      // as connected even after auth removal).
      set((state) => {
        const newDisconnected = new Set(state._disconnectedIds)
        newDisconnected.add(providerId)
        const updatedProviders = state.providers
          .map((p) => (p.id === providerId ? { ...p, configured: false } : p))
          .sort((a, b) => {
            if (a.configured !== b.configured) return a.configured ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        return {
          _disconnectedIds: newDisconnected,
          providers: updatedProviders,
          configuredProviders: state.configuredProviders.filter((p) => p.id !== providerId),
          models: state.models.filter((m) => m.provider !== providerId),
        }
      })
      return true
    } catch (err) {
      console.error('Failed to disconnect provider:', err)
      toast.error('Failed to disconnect provider', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      return false
    }
  },

  // Refresh custom provider IDs from opencode.json
  refreshCustomProviderIds: async (workspacePath: string) => {
    try {
      const ids = await getCustomProviderIds(workspacePath)
      set({ customProviderIds: ids })
    } catch (err) {
      console.error('Failed to load custom provider IDs:', err)
    }
  },

  // Add a custom OpenAI-compatible provider
  addCustomProvider: async (workspacePath: string, config: CustomProviderConfig, _apiKey: string) => {
    try {
      const providerId = await addCustomProviderToConfig(workspacePath, config)
      toast.success('Custom provider added', {
        description: `${config.name} has been added to opencode.json. Restarting OpenCode...`,
      })
      return providerId
    } catch (err) {
      console.error('Failed to add custom provider:', err)
      toast.error('Failed to add custom provider', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      return null
    }
  },

  // Remove a custom provider from opencode.json
  removeCustomProvider: async (workspacePath: string, providerId: string) => {
    try {
      await removeCustomProviderFromConfig(workspacePath, providerId)
      toast.success('Custom provider removed', {
        description: `Provider has been removed. Restarting OpenCode...`,
      })
      return true
    } catch (err) {
      console.error('Failed to remove custom provider:', err)
      toast.error('Failed to remove custom provider', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      return false
    }
  },

  // Select a model and sync to opencode backend
  selectModel: async (providerId: string, modelId: string, _modelName: string) => {
    const modelKey = `${providerId}/${modelId}`
    set({ currentModelKey: modelKey })

    // Cache in localStorage as fallback
    localStorage.setItem('teamclaw-selected-model', modelKey)

    const client = tryGetClient()
    if (!client) return
    try {
      await client.updateConfig({ model: modelKey })
    } catch (err) {
      console.error('Failed to update model config:', err)
      toast.error('Failed to update model', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  },

  // Initialize all data at once
  initAll: async () => {
    await Promise.all([
      get().refreshProviders(),
      get().refreshConfiguredProviders(),
      get().refreshCurrentModel(),
    ])

    // After loading, resolve selected model:
    // Priority: opencode config > localStorage > first available model
    const { currentModelKey, models } = get()

    let resolvedKey = currentModelKey

    if (!resolvedKey || !models.find((m) => `${m.provider}/${m.id}` === resolvedKey)) {
      // Try localStorage fallback
      const saved = localStorage.getItem('teamclaw-selected-model')
      if (saved && models.find((m) => `${m.provider}/${m.id}` === saved)) {
        resolvedKey = saved
      } else if (models.length > 0) {
        // Last resort: first available model
        resolvedKey = `${models[0].provider}/${models[0].id}`
      }
    }

    if (resolvedKey) {
      set({ currentModelKey: resolvedKey })
      // Sync localStorage to be consistent
      localStorage.setItem('teamclaw-selected-model', resolvedKey)
    }
  },
}))

// Helper: split "providerId/modelId" safely – modelId itself may contain '/'
function splitModelKey(key: string): [string, string] | null {
  const idx = key.indexOf('/')
  if (idx === -1) return null
  return [key.substring(0, idx), key.substring(idx + 1)]
}

// Helper: get the currently selected ModelOption from the store
export function getSelectedModelOption(state: ProviderState): ModelOption | null {
  if (!state.currentModelKey) return null
  const parts = splitModelKey(state.currentModelKey)
  if (!parts) return null
  const [providerId, modelId] = parts
  return state.models.find((m) => m.provider === providerId && m.id === modelId) || null
}
