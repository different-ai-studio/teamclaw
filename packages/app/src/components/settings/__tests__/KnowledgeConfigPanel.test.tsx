import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KnowledgeConfigPanel } from '../KnowledgeConfigPanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

const mockLoadConfig = vi.fn()
const mockSaveConfig = vi.fn()

let mockStoreState = {
  config: null as Record<string, unknown> | null,
  isLoadingConfig: false,
  loadConfig: mockLoadConfig,
  saveConfig: mockSaveConfig,
}

vi.mock('@/stores/knowledge', () => ({
  useKnowledgeStore: (selector?: (s: unknown) => unknown) => {
    if (selector) return selector(mockStoreState)
    return mockStoreState
  },
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}))

const baseConfig = {
  embeddingProvider: 'openai',
  embeddingModel: 'text-embedding-3-large',
  embeddingDimensions: 2560,
  embeddingApiKey: '',
  embeddingBaseUrl: 'https://api.openai.com/v1',
  chunkSize: 800,
  chunkOverlap: 100,
  autoIndex: true,
  hybridWeight: 0.7,
  rerankEnabled: false,
  rerankProvider: 'compass',
  rerankModel: '',
  rerankApiKey: undefined,
  rerankBaseUrl: '',
  rerankTopK: 20,
  fileWatcherEnabled: false,
  autoInjectEnabled: false,
  autoInjectThreshold: 0.7,
  autoInjectTopK: 3,
  autoInjectMaxTokens: 2000,
  memoryEnabled: false,
  memoryAutoExtract: false,
}

describe('KnowledgeConfigPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStoreState = {
      config: null,
      isLoadingConfig: false,
      loadConfig: mockLoadConfig,
      saveConfig: mockSaveConfig,
    }
  })

  it('shows loading spinner when isLoadingConfig is true', () => {
    mockStoreState.isLoadingConfig = true
    const { container } = render(<KnowledgeConfigPanel />)
    // Should have an svg (Loader2 spinner) but no tab list
    expect(container.querySelector('svg.animate-spin')).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('shows loading spinner when config is null', () => {
    mockStoreState.config = null
    const { container } = render(<KnowledgeConfigPanel />)
    expect(container.querySelector('svg.animate-spin')).toBeTruthy()
  })

  it('renders tab list when config is loaded', () => {
    mockStoreState.config = baseConfig
    render(<KnowledgeConfigPanel />)
    expect(screen.getByRole('tablist')).toBeTruthy()
  })

  it('renders 4 tabs', () => {
    mockStoreState.config = baseConfig
    render(<KnowledgeConfigPanel />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(4)
  })

  it('hides auto-inject sub-fields when disabled', () => {
    mockStoreState.config = { ...baseConfig, autoInjectEnabled: false }
    render(<KnowledgeConfigPanel />)
    // Threshold input should not be present
    expect(screen.queryByLabelText('Similarity Threshold')).toBeNull()
  })

  it('shows auto-inject sub-fields when enabled', () => {
    mockStoreState.config = { ...baseConfig, autoInjectEnabled: true }
    render(<KnowledgeConfigPanel />)
    expect(screen.getByLabelText('Similarity Threshold')).toBeTruthy()
    expect(screen.getByLabelText('Top K')).toBeTruthy()
    expect(screen.getByLabelText('Token Limit')).toBeTruthy()
  })

  it('renders save and reset buttons', () => {
    mockStoreState.config = baseConfig
    render(<KnowledgeConfigPanel />)
    expect(screen.getByText('Save Configuration')).toBeTruthy()
    expect(screen.getByText('Reset')).toBeTruthy()
  })

  it('calls loadConfig on mount', () => {
    mockStoreState.config = baseConfig
    render(<KnowledgeConfigPanel />)
    expect(mockLoadConfig).toHaveBeenCalled()
  })
})
