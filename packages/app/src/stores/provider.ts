import { create } from 'zustand'
import { toast } from 'sonner'
import { appShortName } from '@/lib/build-config'
import { invoke } from '@tauri-apps/api/core'
import { workspaceScopedKey } from '@/lib/storage'
import { sessionFlowLog } from '@/lib/session-flow-log'
import { useWorkspaceStore } from '@/stores/workspace'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { AgentType } from '@/lib/proto/amux_pb'
import {
  encodeWorkspaceId,
  putDaemonProviderAuth,
  deleteDaemonProviderAuth,
  getDaemonProviders,
  getDaemonProviderAuthMethods,
  postDaemonProviderOAuthAuthorize,
  postDaemonProviderOAuthCallback,
  reloadDaemonRuntime,
  type DaemonProviderInfo,
} from '@/lib/daemon-local-client'
import {
  fallbackProviderAuthMethods,
  mergeProviderAuthMethods,
} from '@/lib/daemon-provider-auth'
import {
  type CustomProviderConfig,
  customProviderIdFromName,
  providerApiKeyName,
} from '@/lib/opencode/config'

const SELECTED_MODEL_BASE = `${appShortName}-selected-model`
const DEFAULT_CONNECTABLE_PROVIDERS: ProviderEntry[] = [
  { id: 'openai', name: 'OpenAI', configured: false },
]

function selectedModelStorageKey(): string {
  return workspaceScopedKey(SELECTED_MODEL_BASE, useWorkspaceStore.getState().workspacePath)
}

// Read the saved model, preferring the workspace-scoped key but falling back
// to the legacy unscoped key for users upgrading from before workspace scoping.
function readSavedSelectedModel(): string | null {
  const scoped = localStorage.getItem(selectedModelStorageKey())
  if (scoped !== null) return scoped
  return localStorage.getItem(SELECTED_MODEL_BASE)
}

function daemonProvidersToConfigured(
  daemonProviders: DaemonProviderInfo[],
  disconnectedIds: Set<string>,
): { configuredProviders: ConfiguredProvider[]; providers: ProviderEntry[] } {
  const configuredProviders: ConfiguredProvider[] = daemonProviders
    .filter((p) => p.authenticated && !disconnectedIds.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.display_name,
      models: p.models.map((modelId) => ({ id: modelId, name: modelId })),
    }))

  const providers: ProviderEntry[] = daemonProviders.map((p) => ({
    id: p.id,
    name: p.display_name,
    configured: p.authenticated && !disconnectedIds.has(p.id),
  }))

  providers.sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return { configuredProviders, providers }
}

async function persistProviderApiKeyBestEffort(
  providerId: string,
  apiKey: string,
  description: string,
): Promise<void> {
  const isRef = /^\$\{?.+\}?$/.test(apiKey)
  if (!apiKey || isRef) return
  try {
    await invoke('env_catalog_set', {
      scope: 'personal',
      key: providerApiKeyName(providerId),
      value: apiKey,
      description,
      workspacePath: useWorkspaceStore.getState().workspacePath ?? undefined,
    })
  } catch (err) {
    console.warn('[LLM] env_catalog_set failed; continuing with direct provider auth', err)
  }
}

async function reloadRuntimeAfterProviderChange(workspacePath: string): Promise<void> {
  try {
    const outcome = await reloadDaemonRuntime(encodeWorkspaceId(workspacePath))
    if (outcome === 'restart_required') {
      toast.info('Agent restart required', {
        description: 'Provider credentials changed. Start a new session to use the updated connection.',
      })
    }
  } catch (err) {
    console.warn('[LLM] runtime reload after provider change failed:', err)
  }
}

function providerDisplayName(providerId: string): string {
  switch (providerId.toLowerCase()) {
    case 'openai':
      return 'OpenAI'
    case 'opencode':
      return 'OpenCode'
    case 'claude-code':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    default:
      return providerId
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ') || providerId
  }
}

function splitRuntimeModelId(agentType: AgentType, runtimeModelId: string): [string, string] {
  const trimmed = runtimeModelId.trim()
  const slash = trimmed.indexOf('/')
  if (slash > 0) {
    return [trimmed.slice(0, slash), trimmed.slice(slash + 1)]
  }
  switch (agentType) {
    case AgentType.OPENCODE:
      return ['opencode', trimmed]
    case AgentType.CODEX:
      return ['codex', trimmed]
    case AgentType.CLAUDE_CODE:
      return ['claude-code', trimmed]
    default:
      return ['opencode', trimmed]
  }
}

function runtimeModelsToConfigured(disconnectedIds: Set<string>): ConfiguredProvider[] {
  const byProvider = new Map<string, ConfiguredProvider>()
  const entries = Object.values(useRuntimeStateStore.getState().byRuntimeId)

  for (const entry of entries) {
    const agentType = entry.info.agentType
    if (agentType !== AgentType.OPENCODE && agentType !== AgentType.CODEX) continue

    for (const runtimeModel of entry.info.availableModels) {
      const modelRef = runtimeModel.id?.trim()
      if (!modelRef) continue

      const [providerId, modelId] = splitRuntimeModelId(agentType, modelRef)
      if (!providerId || !modelId || disconnectedIds.has(providerId)) continue

      let provider = byProvider.get(providerId)
      if (!provider) {
        provider = {
          id: providerId,
          name: providerDisplayName(providerId),
          models: [],
        }
        byProvider.set(providerId, provider)
      }
      if (!provider.models.some((model) => model.id === modelId)) {
        provider.models.push({
          id: modelId,
          name: runtimeModel.displayName?.trim() || modelId,
        })
      }
    }
  }

  return Array.from(byProvider.values())
}

function mergeConfiguredProviders(
  configuredProviders: ConfiguredProvider[],
  runtimeProviders: ConfiguredProvider[],
): ConfiguredProvider[] {
  const merged = new Map<string, ConfiguredProvider>()

  for (const provider of [...configuredProviders, ...runtimeProviders]) {
    const existing = merged.get(provider.id)
    if (!existing) {
      merged.set(provider.id, {
        id: provider.id,
        name: provider.name,
        models: [...provider.models],
      })
      continue
    }
    for (const model of provider.models) {
      if (!existing.models.some((existingModel) => existingModel.id === model.id)) {
        existing.models.push(model)
      }
    }
  }

  return Array.from(merged.values())
}

function mergeProviderEntries(
  providers: ProviderEntry[],
  configuredProviders: ConfiguredProvider[],
): ProviderEntry[] {
  const byProvider = new Map(
    [...DEFAULT_CONNECTABLE_PROVIDERS, ...providers].map((provider) => [
      provider.id,
      { ...provider },
    ]),
  )

  for (const provider of configuredProviders) {
    const existing = byProvider.get(provider.id)
    if (existing) {
      existing.configured = true
      if (!existing.name) existing.name = provider.name
    } else {
      byProvider.set(provider.id, {
        id: provider.id,
        name: provider.name,
        configured: true,
      })
    }
  }

  return Array.from(byProvider.values()).sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

const daemonProvidersInflight = new Map<string, Promise<DaemonProviderInfo[] | null>>()

async function loadDaemonProvidersForWorkspace(workspacePath: string): Promise<DaemonProviderInfo[] | null> {
  const existing = daemonProvidersInflight.get(workspacePath)
  if (existing) return existing

  const request = getDaemonProviders(encodeWorkspaceId(workspacePath)).finally(() => {
    daemonProvidersInflight.delete(workspacePath)
  })
  daemonProvidersInflight.set(workspacePath, request)
  return request
}

async function loadDaemonProviderSnapshot(
  workspacePath: string,
  disconnectedIds: Set<string>,
): Promise<{
  configuredProviders: ConfiguredProvider[]
  providers: ProviderEntry[]
} | null> {
  const daemonProviders = await loadDaemonProvidersForWorkspace(workspacePath)
  const snapshot = daemonProvidersToConfigured(daemonProviders ?? [], disconnectedIds)
  const configuredProviders = mergeConfiguredProviders(
    snapshot.configuredProviders,
    runtimeModelsToConfigured(disconnectedIds),
  )
  return {
    configuredProviders,
    providers: mergeProviderEntries(snapshot.providers, configuredProviders),
  }
}

/** Load configured models for an explicit workspace path (cron scope, etc.). */
export async function loadConfiguredProvidersForWorkspace(
  workspacePath: string,
): Promise<{ configuredProviders: ConfiguredProvider[]; models: ModelOption[] } | null> {
  const snapshot = await loadDaemonProviderSnapshot(workspacePath, new Set())
  if (!snapshot) return null
  return {
    configuredProviders: snapshot.configuredProviders,
    models: flattenConfiguredProviders(snapshot.configuredProviders),
  }
}

export interface ProviderAuthMethod {
  type: 'oauth' | 'api'
  label: string
  prompts?: unknown[]
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

function flattenConfiguredProviders(configuredProviders: ConfiguredProvider[]): ModelOption[] {
  return configuredProviders.flatMap((provider) =>
    provider.models.map((model) => ({
      id: model.id,
      name: model.name,
      provider: provider.id,
    })),
  )
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

  // Auth methods per provider (from GET /provider/auth)
  authMethods: Record<string, ProviderAuthMethod[]>

  // Custom provider IDs (defined in the legacy workspace config)
  customProviderIds: string[]

  // Provider IDs disconnected in the current session. The agent runtime reports
  // custom providers (defined in the legacy workspace config) as "connected"
  // even after auth is removed, so we track them here and filter during refreshes.
  _disconnectedIds: Set<string>
  _workspacePath: string | null

  // Actions
  refreshAuthMethods: () => Promise<void>
  connectProviderOAuth: (providerId: string, methodIndex: number) => Promise<
    { status: 'pending'; url: string; instructions: string; methodType: 'auto' | 'code' } |
    { status: 'success' } |
    { status: 'error'; message: string }
  >
  completeOAuthCallback: (providerId: string, methodIndex: number, code?: string) => Promise<boolean>
  refreshProviders: () => Promise<void>
  refreshConfiguredProviders: () => Promise<void>
  refreshCurrentModel: () => Promise<void>
  refreshCustomProviderIds: (workspacePath: string) => Promise<void>
  connectProvider: (providerId: string, apiKey: string) => Promise<boolean>
  disconnectProvider: (providerId: string) => Promise<boolean>
  addCustomProvider: (workspacePath: string, config: CustomProviderConfig, apiKey: string) => Promise<string | null>
  updateCustomProvider: (workspacePath: string, providerId: string, config: CustomProviderConfig) => Promise<boolean>
  getCustomProvider: (workspacePath: string, providerId: string) => Promise<CustomProviderConfig | null>
  removeCustomProvider: (workspacePath: string, providerId: string) => Promise<boolean>
  selectModel: (providerId: string, modelId: string, modelName: string) => Promise<void>
  initAll: () => Promise<void>
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  // Initial state
  authMethods: {},
  providers: [],
  providersLoading: false,
  configuredProviders: [],
  configuredProvidersLoading: false,
  models: [],
  currentModelKey: null,
  customProviderIds: [],
  _disconnectedIds: new Set<string>(),
  _workspacePath: null,

  refreshAuthMethods: async () => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) {
      set({ authMethods: fallbackProviderAuthMethods() })
      return
    }
    try {
      const methods = await getDaemonProviderAuthMethods(encodeWorkspaceId(workspacePath))
      if (methods) {
        set({
          authMethods: mergeProviderAuthMethods(
            methods as Record<string, ProviderAuthMethod[]>,
          ),
        })
        return
      }
    } catch (err) {
      console.error('Failed to load auth methods from daemon:', err)
    }
    set({ authMethods: fallbackProviderAuthMethods() })
  },

  connectProviderOAuth: async (providerId, methodIndex) => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) {
      return { status: 'error' as const, message: 'No workspace selected' }
    }
    const result = await postDaemonProviderOAuthAuthorize(
      encodeWorkspaceId(workspacePath),
      providerId,
      methodIndex,
    )
    if (!result.ok) {
      toast.error('OAuth login failed', { description: result.message })
      return { status: 'error' as const, message: result.message }
    }
    return {
      status: 'pending' as const,
      url: result.url,
      instructions: result.instructions,
      methodType: result.method,
    }
  },

  completeOAuthCallback: async (providerId, methodIndex, code) => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return false
    const result = await postDaemonProviderOAuthCallback(
      encodeWorkspaceId(workspacePath),
      providerId,
      methodIndex,
      code,
    )
    if (!result.ok) {
      toast.error('OAuth login failed', { description: result.message })
      return false
    }
    set((state) => {
      const newDisconnected = new Set(state._disconnectedIds)
      newDisconnected.delete(providerId)
      return { _disconnectedIds: newDisconnected }
    })
    toast.success('Provider connected', { description: `Successfully connected ${providerId}` })
    await reloadRuntimeAfterProviderChange(workspacePath)
    await Promise.all([get().refreshProviders(), get().refreshConfiguredProviders()])
    return true
  },

  refreshProviders: async () => {
    set({ providersLoading: true })
    try {
      const workspacePath = useWorkspaceStore.getState().workspacePath
      if (!workspacePath) {
        set({ providersLoading: false })
        return
      }
      const snapshot = await loadDaemonProviderSnapshot(workspacePath, get()._disconnectedIds)
      if (!snapshot) {
        set({ providersLoading: false })
        return
      }
      set({ providers: snapshot.providers, providersLoading: false })
    } catch (err) {
      console.error('Failed to load providers:', err)
      set({ providersLoading: false })
    }
  },

  refreshConfiguredProviders: async () => {
    set({ configuredProvidersLoading: true })
    try {
      const workspacePath = useWorkspaceStore.getState().workspacePath
      if (!workspacePath) {
        set({ configuredProvidersLoading: false })
        return
      }
      const snapshot = await loadDaemonProviderSnapshot(workspacePath, get()._disconnectedIds)
      if (!snapshot) {
        set({ configuredProvidersLoading: false })
        return
      }
      set({
        configuredProviders: snapshot.configuredProviders,
        models: flattenConfiguredProviders(snapshot.configuredProviders),
        configuredProvidersLoading: false,
      })
    } catch (err) {
      console.error('Failed to load configured providers:', err)
      set({ configuredProvidersLoading: false })
    }
  },

  refreshCurrentModel: async () => {
    const saved = readSavedSelectedModel()
    if (saved) set({ currentModelKey: saved })
  },

  connectProvider: async (providerId: string, apiKey: string) => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) {
      toast.error('No workspace selected')
      return false
    }
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) return false
    try {
      await persistProviderApiKeyBestEffort(
        providerId,
        trimmedKey,
        `API key for provider ${providerId}`,
      )
      // Daemon-backed OpenCode reads literal apiKey from opencode.json; it does
      // not resolve desktop ${ref} placeholders from the personal secret store.
      await putDaemonProviderAuth(encodeWorkspaceId(workspacePath), providerId, {
        api_key: trimmedKey,
      })
      if (providerId !== 'team') {
        toast.success('Provider connected', { description: `Successfully connected ${providerId}` })
      }
      set((state) => {
        const newDisconnected = new Set(state._disconnectedIds)
        newDisconnected.delete(providerId)
        return { _disconnectedIds: newDisconnected }
      })
      await reloadRuntimeAfterProviderChange(workspacePath)
      await Promise.all([get().refreshProviders(), get().refreshConfiguredProviders()])
      return true
    } catch (err) {
      console.error('[LLM connect] Failed to connect provider:', err)
      toast.error('Failed to connect provider', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      return false
    }
  },

  disconnectProvider: async (providerId: string) => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) {
      toast.error('No workspace selected')
      return false
    }
    try {
      await deleteDaemonProviderAuth(encodeWorkspaceId(workspacePath), providerId)
      await reloadRuntimeAfterProviderChange(workspacePath)
      toast.success('Provider disconnected', { description: `Successfully disconnected ${providerId}` })
      set((state) => {
        const newDisconnected = new Set(state._disconnectedIds)
        newDisconnected.add(providerId)
        return {
          _disconnectedIds: newDisconnected,
          providers: state.providers
            .map((p) => (p.id === providerId ? { ...p, configured: false } : p))
            .sort((a, b) => {
              if (a.configured !== b.configured) return a.configured ? -1 : 1
              return a.name.localeCompare(b.name)
            }),
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

  // Refresh custom provider IDs from the daemon workspace-control API.
  refreshCustomProviderIds: async (workspacePath: string) => {
    try {
      const daemonProviders = await loadDaemonProvidersForWorkspace(workspacePath)
      set({
        customProviderIds: (daemonProviders ?? [])
          .filter((p) => p.id !== 'team' && p.authenticated)
          .map((p) => p.id),
      })
    } catch (err) {
      console.error('Failed to load custom provider IDs:', err)
      set({ customProviderIds: [] })
    }
  },

  // Add a custom OpenAI-compatible provider via daemon workspace-control API.
  addCustomProvider: async (workspacePath: string, config: CustomProviderConfig, apiKey: string) => {
    const providerId = customProviderIdFromName(config.name)
    if (!providerId) {
      toast.error('Failed to add custom provider', {
        description: 'Provider name must include at least one letter or number.',
      })
      return null
    }
    const wsId = encodeWorkspaceId(workspacePath)
    try {
      await persistProviderApiKeyBestEffort(
        providerId,
        apiKey,
        `API key for provider ${config.name}`,
      )
      await putDaemonProviderAuth(wsId, providerId, {
        api_key: apiKey.trim(),
        base_url: config.baseURL || undefined,
        display_name: config.name,
        models: config.models.map((m) => ({ model_id: m.modelId, model_name: m.modelName })),
      })
      set((state) => {
        const newDisconnected = new Set(state._disconnectedIds)
        newDisconnected.delete(providerId)
        return { _disconnectedIds: newDisconnected }
      })
      await reloadRuntimeAfterProviderChange(workspacePath)
      await Promise.all([get().refreshProviders(), get().refreshConfiguredProviders()])
      toast.success('Custom provider added', {
        description: `${config.name} has been added. Restarting agent...`,
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

  // Update an existing custom provider via daemon workspace-control API.
  updateCustomProvider: async (workspacePath: string, providerId: string, config: CustomProviderConfig) => {
    const wsId = encodeWorkspaceId(workspacePath)
    try {
      let storedApiKey = ''
      if (config.apiKey && !/^\$\{?.+\}?$/.test(config.apiKey)) {
        await persistProviderApiKeyBestEffort(
          providerId,
          config.apiKey,
          `API key for provider ${config.name}`,
        )
        storedApiKey = config.apiKey.trim()
      }
      await putDaemonProviderAuth(wsId, providerId, {
        api_key: storedApiKey,
        base_url: config.baseURL || undefined,
        display_name: config.name,
        models: config.models.map((m) => ({ model_id: m.modelId, model_name: m.modelName })),
      })
      await reloadRuntimeAfterProviderChange(workspacePath)
      await Promise.all([get().refreshProviders(), get().refreshConfiguredProviders()])
      toast.success('Custom provider updated', {
        description: `${config.name} has been updated. Restarting agent...`,
      })
      return true
    } catch (err) {
      console.error('Failed to update custom provider:', err)
      toast.error('Failed to update custom provider', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      return false
    }
  },

  // Get a custom provider config from the daemon workspace-control API.
  getCustomProvider: async (workspacePath: string, providerId: string) => {
    try {
      const providers = await loadDaemonProvidersForWorkspace(workspacePath)
      const p = providers?.find((x) => x.id === providerId)
      if (!p) return null
      return {
        name: p.display_name,
        baseURL: p.base_url ?? '',
        models: p.models.map((id) => ({ modelId: id, modelName: id })),
      } satisfies CustomProviderConfig
    } catch (err) {
      console.error('Failed to get custom provider:', err)
      return null
    }
  },

  // Remove a custom provider via daemon workspace-control API.
  removeCustomProvider: async (workspacePath: string, providerId: string) => {
    const wsId = encodeWorkspaceId(workspacePath)
    try {
      await deleteDaemonProviderAuth(wsId, providerId)
      toast.success('Custom provider removed', {
        description: `Provider has been removed. Restarting agent...`,
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

  // Select a model for the OpenCode-backed settings/chat UI.
  selectModel: async (providerId: string, modelId: string, _modelName: string) => {
    const modelKey = `${providerId}/${modelId}`
    set({ currentModelKey: modelKey })

    // Cache in workspace-scoped localStorage as fallback
    localStorage.setItem(selectedModelStorageKey(), modelKey)
  },

  // Initialize all data at once
  initAll: async () => {
    const workspacePathAtStart = useWorkspaceStore.getState().workspacePath
    const previousWorkspacePath = get()._workspacePath
    const workspaceChanged =
      previousWorkspacePath !== null && previousWorkspacePath !== workspacePathAtStart
    if (workspaceChanged) {
      set({ currentModelKey: null, _workspacePath: workspacePathAtStart ?? null })
    } else if (previousWorkspacePath === null) {
      set({ _workspacePath: workspacePathAtStart ?? null })
    }

    await get().refreshCurrentModel().catch(() => undefined)

    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (workspacePath) {
      set({ providersLoading: true, configuredProvidersLoading: true })
      try {
        const daemonProviders = await loadDaemonProvidersForWorkspace(workspacePath)
        const baseSnapshot = daemonProvidersToConfigured(daemonProviders ?? [], get()._disconnectedIds)
        const configuredProviders = mergeConfiguredProviders(
          baseSnapshot.configuredProviders,
          runtimeModelsToConfigured(get()._disconnectedIds),
        )
        set({
          providers: mergeProviderEntries(baseSnapshot.providers, configuredProviders),
          configuredProviders,
          models: flattenConfiguredProviders(configuredProviders),
          customProviderIds: (daemonProviders ?? [])
            .filter((p) => p.id !== 'team' && p.authenticated)
            .map((p) => p.id),
        })
      } catch (err) {
        console.error('Failed to initialize providers:', err)
      } finally {
        set({ providersLoading: false, configuredProvidersLoading: false })
      }
    }

    const { currentModelKey } = get()
    const availableModels = get().models

    let resolvedKey = currentModelKey
    let resolvedSource = resolvedKey ? 'currentModelKey' : 'none'

    if (!resolvedKey || !availableModels.find((m) => `${m.provider}/${m.id}` === resolvedKey)) {
      const saved = readSavedSelectedModel()
      if (saved && availableModels.find((m) => `${m.provider}/${m.id}` === saved)) {
        resolvedKey = saved
        resolvedSource = 'localStorage'
      } else if (availableModels.length > 0) {
        resolvedKey = `${availableModels[0].provider}/${availableModels[0].id}`
        resolvedSource = 'firstAvailable'
      } else {
        resolvedKey = null
        resolvedSource = 'none'
      }
    }

    sessionFlowLog('provider.init_all.resolve_model', {
      currentModelKey,
      resolvedKey,
      resolvedSource,
      availableModelKeys: availableModels.map((model) => `${model.provider}/${model.id}`),
    })

    if (resolvedKey) {
      set({ currentModelKey: resolvedKey })
      // Sync workspace-scoped localStorage to be consistent
      localStorage.setItem(selectedModelStorageKey(), resolvedKey)
    } else {
      set({ currentModelKey: null })
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

export function getModelOptionsForSelectedBackend(
  state: Pick<ProviderState, 'models' | 'currentModelKey'>,
): ModelOption[] {
  if (!state.currentModelKey) return state.models
  const parts = splitModelKey(state.currentModelKey)
  if (!parts) return state.models
  const [providerId] = parts
  return state.models.filter((m) => m.provider === providerId)
}
