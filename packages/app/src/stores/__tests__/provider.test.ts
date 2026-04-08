import { describe, it, expect, vi, beforeEach } from 'vitest'
import { appShortName } from '@/lib/build-config'

const mockGetProviders = vi.fn().mockResolvedValue({ all: [], connected: [] })
const mockGetConfigProviders = vi.fn().mockResolvedValue({ providers: [] })
const mockGetConfig = vi.fn().mockResolvedValue({ model: null })
const mockUpdateConfig = vi.fn().mockResolvedValue(undefined)
const mockSetAuth = vi.fn().mockResolvedValue(undefined)
const mockDeleteAuth = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/opencode/sdk-client', () => ({
  getOpenCodeClient: () => ({
    getProviders: mockGetProviders,
    getConfigProviders: mockGetConfigProviders,
    getConfig: mockGetConfig,
    updateConfig: mockUpdateConfig,
    setAuth: mockSetAuth,
    deleteAuth: mockDeleteAuth,
  }),
}))

vi.mock('@/lib/opencode/config', () => ({
  addCustomProviderToConfig: vi.fn().mockResolvedValue('custom-1'),
  removeCustomProviderFromConfig: vi.fn().mockResolvedValue(undefined),
  getCustomProviderIds: vi.fn().mockResolvedValue([]),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

// Mock localStorage for non-jsdom environments
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

beforeEach(() => {
  vi.clearAllMocks()
  localStorageMock.clear()
})

describe('useProviderStore', () => {
  it('has correct initial state', async () => {
    const { useProviderStore } = await import('@/stores/provider')
    const state = useProviderStore.getState()
    expect(state.providers).toEqual([])
    expect(state.models).toEqual([])
    expect(state.currentModelKey).toBeNull()
    expect(state.providersLoading).toBe(false)
  })

  it('selectModel sets currentModelKey and saves to localStorage', async () => {
    const { useProviderStore } = await import('@/stores/provider')
    await useProviderStore.getState().selectModel('openai', 'gpt-4', 'GPT-4')
    expect(useProviderStore.getState().currentModelKey).toBe('openai/gpt-4')
    expect(localStorage.getItem(`${appShortName}-selected-model`)).toBe('openai/gpt-4')
  })

  it('refreshProviders calls client and updates state', async () => {
    mockGetProviders.mockResolvedValueOnce({
      all: [{ id: 'openai', name: 'OpenAI' }],
      connected: ['openai'],
    })
    const { useProviderStore } = await import('@/stores/provider')
    await useProviderStore.getState().refreshProviders()
    const state = useProviderStore.getState()
    expect(state.providers.length).toBe(1)
    expect(state.providers[0].id).toBe('openai')
    expect(state.providers[0].configured).toBe(true)
  })
})

describe('getSelectedModelOption', () => {
  it('returns null when currentModelKey is null', async () => {
    const { getSelectedModelOption } = await import('@/stores/provider')
    const result = getSelectedModelOption({
      currentModelKey: null,
      models: [],
    } as any)
    expect(result).toBeNull()
  })

  it('returns matching model when key matches', async () => {
    const { getSelectedModelOption } = await import('@/stores/provider')
    const result = getSelectedModelOption({
      currentModelKey: 'openai/gpt-4',
      models: [{ id: 'gpt-4', name: 'GPT-4', provider: 'openai' }],
    } as any)
    expect(result).toEqual({ id: 'gpt-4', name: 'GPT-4', provider: 'openai' })
  })
})
