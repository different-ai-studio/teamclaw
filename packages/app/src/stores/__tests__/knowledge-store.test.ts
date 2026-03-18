import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Tauri invoke — use vi.hoisted so variables are available in vi.mock factories
const { mockInvoke, mockToast, mockWorkspacePath } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockToast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
  mockWorkspacePath: { workspacePath: '/test/workspace' },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('sonner', () => ({
  toast: mockToast,
}))

vi.mock('@/lib/i18n', () => ({
  default: {
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && 'message' in opts) return `${key}:${opts.message}`
      if (opts && 'count' in opts) return `${key}:${opts.count}`
      return key
    },
  },
}))

vi.mock('../workspace', () => ({
  useWorkspaceStore: Object.assign(
    () => mockWorkspacePath,
    {
      getState: () => mockWorkspacePath,
      subscribe: vi.fn(),
    },
  ),
}))

// Import after mocks
import { useKnowledgeStore } from '../knowledge'

function resetStore() {
  useKnowledgeStore.setState({
    indexStatus: null,
    isIndexing: false,
    indexProgress: null,
    needsReindex: false,
    searchResults: [],
    isSearching: false,
    searchQuery: '',
    searchMode: 'hybrid',
    searchTime: 0,
    searchReranked: false,
    searchRerankError: null,
    documents: [],
    isLoadingDocuments: false,
    config: null,
    isLoadingConfig: false,
  })
}

describe('Knowledge Store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
  })

  // ─── loadIndexStatus ────────────────────────────────────────────────────

  describe('loadIndexStatus', () => {
    it('does nothing when workspacePath is empty', async () => {
      mockWorkspacePath.workspacePath = ''
      await useKnowledgeStore.getState().loadIndexStatus()
      expect(mockInvoke).not.toHaveBeenCalled()
      mockWorkspacePath.workspacePath = '/test/workspace'
    })

    it('sets indexStatus on success', async () => {
      const status = { totalDocuments: 5, totalChunks: 20, bm25Documents: 5 }
      mockInvoke.mockResolvedValueOnce(status)

      await useKnowledgeStore.getState().loadIndexStatus()

      expect(mockInvoke).toHaveBeenCalledWith('rag_get_index_status', {
        workspacePath: '/test/workspace',
      })
      expect(useKnowledgeStore.getState().indexStatus).toEqual(status)
    })

    it('shows toast on error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('fail'))

      await useKnowledgeStore.getState().loadIndexStatus()

      expect(mockToast.error).toHaveBeenCalledWith('knowledge.toast.loadIndexStatusFailed')
    })
  })

  // ─── startIndex ─────────────────────────────────────────────────────────

  describe('startIndex', () => {
    it('sets isIndexing during execution', async () => {
      mockInvoke
        .mockImplementationOnce(() => {
          // Check state during invoke call
          expect(useKnowledgeStore.getState().isIndexing).toBe(true)
          return Promise.resolve({ indexed: 1, skipped: 0, failed: 0, totalChunks: 5, durationMs: 100 })
        })
        .mockResolvedValueOnce({ totalDocuments: 1, totalChunks: 5, bm25Documents: 1 })

      await useKnowledgeStore.getState().startIndex()

      expect(useKnowledgeStore.getState().isIndexing).toBe(false)
    })

    it('shows success toast in normal mode', async () => {
      mockInvoke
        .mockResolvedValueOnce({ indexed: 3, skipped: 0, failed: 0, totalChunks: 15, durationMs: 200 })
        .mockResolvedValueOnce({ totalDocuments: 3, totalChunks: 15, bm25Documents: 3 })

      await useKnowledgeStore.getState().startIndex()

      expect(mockToast.success).toHaveBeenCalledWith('knowledge.toast.indexComplete:3')
    })

    it('shows force rebuild toast and clears needsReindex', async () => {
      useKnowledgeStore.setState({ needsReindex: true })
      mockInvoke
        .mockResolvedValueOnce({ indexed: 2, skipped: 0, failed: 0, totalChunks: 10, durationMs: 300 })
        .mockResolvedValueOnce({ totalDocuments: 2, totalChunks: 10, bm25Documents: 2 })

      await useKnowledgeStore.getState().startIndex(undefined, false, true)

      expect(mockToast.success).toHaveBeenCalled()
      expect(useKnowledgeStore.getState().needsReindex).toBe(false)
    })

    it('suppresses toast in silent mode', async () => {
      mockInvoke
        .mockResolvedValueOnce({ indexed: 1, skipped: 0, failed: 0, totalChunks: 5, durationMs: 100 })
        .mockResolvedValueOnce({ totalDocuments: 1, totalChunks: 5, bm25Documents: 1 })

      await useKnowledgeStore.getState().startIndex(undefined, true)

      expect(mockToast.success).not.toHaveBeenCalled()
      expect(mockToast.error).not.toHaveBeenCalled()
    })

    it('shows error toast on failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('disk full'))

      await useKnowledgeStore.getState().startIndex()

      expect(mockToast.error).toHaveBeenCalledWith('knowledge.toast.indexFailed:disk full')
      expect(useKnowledgeStore.getState().isIndexing).toBe(false)
    })
  })

  // ─── search ─────────────────────────────────────────────────────────────

  describe('search', () => {
    it('does nothing for empty query', async () => {
      await useKnowledgeStore.getState().search('')
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('does nothing for whitespace-only query', async () => {
      await useKnowledgeStore.getState().search('   ')
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('sets search results on success', async () => {
      const response = {
        results: [{ content: 'test', source: 'doc.md', score: 0.9, chunkIndex: 0 }],
        totalIndexed: 10,
        queryTimeMs: 50,
        searchMode: 'hybrid',
        degraded: false,
        reranked: true,
        rerankError: undefined,
      }
      mockInvoke.mockResolvedValueOnce(response)

      await useKnowledgeStore.getState().search('test query')

      const state = useKnowledgeStore.getState()
      expect(state.searchResults).toEqual(response.results)
      expect(state.searchTime).toBe(50)
      expect(state.searchReranked).toBe(true)
      expect(state.isSearching).toBe(false)
    })

    it('clears results and shows toast on error', async () => {
      useKnowledgeStore.setState({ searchResults: [{ content: 'old', source: 'x', score: 1, chunkIndex: 0 }] })
      mockInvoke.mockRejectedValueOnce(new Error('timeout'))

      await useKnowledgeStore.getState().search('test')

      expect(useKnowledgeStore.getState().searchResults).toEqual([])
      expect(mockToast.error).toHaveBeenCalled()
    })
  })

  // ─── searchForAutoInject ────────────────────────────────────────────────

  describe('searchForAutoInject', () => {
    it('returns empty array on failure without toast', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('fail'))

      const result = await useKnowledgeStore.getState().searchForAutoInject('query', 5, 0.7)

      expect(result).toEqual([])
      expect(mockToast.error).not.toHaveBeenCalled()
    })

    it('returns empty array for empty query', async () => {
      const result = await useKnowledgeStore.getState().searchForAutoInject('', 5, 0.7)
      expect(result).toEqual([])
      expect(mockInvoke).not.toHaveBeenCalled()
    })
  })

  // ─── setSearchMode ─────────────────────────────────────────────────────

  describe('setSearchMode', () => {
    it('triggers re-search when query exists', async () => {
      useKnowledgeStore.setState({ searchQuery: 'existing query' })
      const response = {
        results: [],
        totalIndexed: 0,
        queryTimeMs: 10,
        searchMode: 'semantic',
        degraded: false,
        reranked: false,
      }
      mockInvoke.mockResolvedValueOnce(response)

      useKnowledgeStore.getState().setSearchMode('semantic')

      expect(useKnowledgeStore.getState().searchMode).toBe('semantic')
      // Wait for async search to be called
      await vi.waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('rag_search', expect.objectContaining({
          searchMode: 'semantic',
        }))
      })
    })

    it('does not search when query is empty', () => {
      useKnowledgeStore.setState({ searchQuery: '' })

      useKnowledgeStore.getState().setSearchMode('bm25')

      expect(useKnowledgeStore.getState().searchMode).toBe('bm25')
      expect(mockInvoke).not.toHaveBeenCalled()
    })
  })

  // ─── saveConfig ─────────────────────────────────────────────────────────

  describe('saveConfig', () => {
    const baseConfig = {
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-large',
      embeddingDimensions: 2560,
      embeddingApiKey: 'sk-test',
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

    it('sets needsReindex when embedding model changes', async () => {
      useKnowledgeStore.setState({ config: baseConfig })
      mockInvoke.mockResolvedValueOnce(undefined)

      const newConfig = { ...baseConfig, embeddingModel: 'different-model' }
      await useKnowledgeStore.getState().saveConfig(newConfig)

      expect(useKnowledgeStore.getState().needsReindex).toBe(true)
      expect(mockToast.warning).toHaveBeenCalled()
    })

    it('sets needsReindex when chunkSize changes', async () => {
      useKnowledgeStore.setState({ config: baseConfig })
      mockInvoke.mockResolvedValueOnce(undefined)

      const newConfig = { ...baseConfig, chunkSize: 500 }
      await useKnowledgeStore.getState().saveConfig(newConfig)

      expect(useKnowledgeStore.getState().needsReindex).toBe(true)
    })

    it('does NOT set needsReindex for non-index fields', async () => {
      useKnowledgeStore.setState({ config: baseConfig })
      mockInvoke.mockResolvedValueOnce(undefined)

      const newConfig = { ...baseConfig, hybridWeight: 0.5, autoInjectEnabled: true }
      await useKnowledgeStore.getState().saveConfig(newConfig)

      expect(useKnowledgeStore.getState().needsReindex).toBe(false)
      expect(mockToast.success).toHaveBeenCalledWith('knowledge.toast.configSaved')
    })

    it('shows error toast on failure', async () => {
      useKnowledgeStore.setState({ config: baseConfig })
      mockInvoke.mockRejectedValueOnce(new Error('write error'))

      await useKnowledgeStore.getState().saveConfig(baseConfig)

      expect(mockToast.error).toHaveBeenCalledWith('knowledge.toast.saveConfigFailed')
    })
  })

  // ─── deleteDocument ─────────────────────────────────────────────────────

  describe('deleteDocument', () => {
    it('reloads documents and status after deletion', async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // rag_delete_document
        .mockResolvedValueOnce([]) // rag_list_documents
        .mockResolvedValueOnce({ totalDocuments: 0, totalChunks: 0, bm25Documents: 0 }) // rag_get_index_status

      await useKnowledgeStore.getState().deleteDocument('test.md')

      expect(mockInvoke).toHaveBeenCalledWith('rag_delete_document', {
        workspacePath: '/test/workspace',
        path: 'test.md',
      })
      expect(mockToast.success).toHaveBeenCalledWith('knowledge.toast.documentDeleted')
      // Should have called 3 invokes total
      expect(mockInvoke).toHaveBeenCalledTimes(3)
    })

    it('shows error toast on failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('permission denied'))

      await useKnowledgeStore.getState().deleteDocument('test.md')

      expect(mockToast.error).toHaveBeenCalledWith('knowledge.toast.deleteDocumentFailed')
    })
  })

  // ─── cleanup ────────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('resets all state to defaults', () => {
      useKnowledgeStore.setState({
        indexStatus: { totalDocuments: 5, totalChunks: 20, bm25Documents: 5 },
        isIndexing: true,
        searchResults: [{ content: 'x', source: 'y', score: 1, chunkIndex: 0 }],
        searchQuery: 'test',
        needsReindex: true,
      })

      useKnowledgeStore.getState().cleanup()

      const state = useKnowledgeStore.getState()
      expect(state.indexStatus).toBeNull()
      expect(state.isIndexing).toBe(false)
      expect(state.searchResults).toEqual([])
      expect(state.searchQuery).toBe('')
      expect(state.needsReindex).toBe(false)
      expect(state.config).toBeNull()
    })
  })
})
