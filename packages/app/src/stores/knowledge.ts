import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import i18n from '@/lib/i18n'
import { useWorkspaceStore } from './workspace'
import { withAsync } from '@/lib/store-utils'

// ============================================================================
// Types
// ============================================================================

export interface DocumentRecord {
  id: number
  path: string
  title?: string
  format: string
  hash: string
  size: number
  chunkCount: number
  indexedAt: string
  updatedAt: string
}

export interface SearchResult {
  content: string
  source: string
  heading?: string
  score: number
  chunkIndex: number
  startLine?: number
  endLine?: number
}

export interface SearchResponse {
  results: SearchResult[]
  totalIndexed: number
  queryTimeMs: number
  searchMode: string
  degraded: boolean
  reranked: boolean
  rerankError?: string
}

export interface IndexResult {
  indexed: number
  skipped: number
  failed: number
  totalChunks: number
  durationMs: number
}

export interface IndexStatus {
  totalDocuments: number
  totalChunks: number
  lastIndexed?: string
  bm25Documents: number
}

export interface RagConfig {
  embeddingProvider: string
  embeddingModel: string
  embeddingDimensions: number
  embeddingApiKey?: string
  embeddingBaseUrl: string
  chunkSize: number
  chunkOverlap: number
  autoIndex: boolean
  hybridWeight: number
  rerankEnabled: boolean
  rerankProvider: string
  rerankModel: string
  rerankApiKey?: string
  rerankBaseUrl: string
  rerankTopK: number
  fileWatcherEnabled: boolean
  // RAG V2: Auto-inject
  autoInjectEnabled: boolean
  autoInjectThreshold: number
  autoInjectTopK: number
  autoInjectMaxTokens: number
  // Long-term Memory
  memoryEnabled: boolean
  memoryAutoExtract: boolean
}

// ============================================================================
// Store
// ============================================================================

interface KnowledgeState {
  // Index state
  indexStatus: IndexStatus | null
  isIndexing: boolean
  indexProgress: IndexResult | null
  needsReindex: boolean  // Track if config changes require index rebuild

  // Search state
  searchResults: SearchResult[]
  isSearching: boolean
  searchQuery: string
  searchMode: 'hybrid' | 'semantic' | 'bm25'
  searchTime: number
  searchReranked: boolean
  searchRerankError: string | null

  // Documents
  documents: DocumentRecord[]
  isLoadingDocuments: boolean

  // Config
  config: RagConfig | null
  isLoadingConfig: boolean

  // Actions - Index
  loadIndexStatus: () => Promise<void>
  startIndex: (path?: string, silent?: boolean, force?: boolean) => Promise<void>
  resetIndexProgress: () => void

  // Actions - Search
  search: (query: string, minScore?: number) => Promise<void>
  searchForAutoInject: (query: string, topK: number, minScore: number) => Promise<SearchResult[]>
  setSearchMode: (mode: 'hybrid' | 'semantic' | 'bm25') => void
  setSearchQuery: (query: string) => void
  clearSearch: () => void

  // Actions - Documents
  loadDocuments: () => Promise<void>
  deleteDocument: (path: string) => Promise<void>

  // Actions - Config
  loadConfig: () => Promise<void>
  saveConfig: (config: RagConfig) => Promise<void>
  setNeedsReindex: (needs: boolean) => void

  // Actions - Watcher
  startWatcher: () => Promise<void>
  stopWatcher: () => Promise<void>
  
  // Auto-init when workspace changes
  initForWorkspace: () => Promise<void>
  cleanup: () => void
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  // Initial state
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

  // ============================================================================
  // Index Actions
  // ============================================================================

  loadIndexStatus: async () => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return

    try {
      const status = await invoke<IndexStatus>('rag_get_index_status', {
        workspacePath,
      })
      set({ indexStatus: status })
    } catch (error) {
      console.error('Failed to load index status:', error)
      toast.error(i18n.t('knowledge.toast.loadIndexStatusFailed'))
    }
  },

  startIndex: async (path?: string, silent = false, force = false) => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return

    set({ isIndexing: true, indexProgress: null })

    try {
      const result = await invoke<IndexResult>('rag_index', {
        workspacePath,
        path: path || null,
        force,
      })

      set({ indexProgress: result })
      
      if (!silent) {
        if (force) {
          toast.success(i18n.t('knowledge.toast.forceRebuildComplete', { count: result.indexed, chunks: result.totalChunks }))
          // Clear the needs reindex flag after force rebuild
          set({ needsReindex: false })
        } else {
          toast.success(i18n.t('knowledge.toast.indexComplete', { count: result.indexed }))
        }
      } else if (result.indexed > 0) {
        // Silent mode: only show if there were actual changes
        console.log(`Background index completed: ${result.indexed} documents updated`)
      }

      // Reload status
      await get().loadIndexStatus()
    } catch (error) {
      console.error('Indexing failed:', error)
      if (!silent) {
        const message = error instanceof Error ? error.message : String(error)
        toast.error(i18n.t('knowledge.toast.indexFailed', { message }))
      }
    } finally {
      set({ isIndexing: false })
    }
  },

  resetIndexProgress: () => {
    set({ indexProgress: null })
  },

  // ============================================================================
  // Search Actions
  // ============================================================================

  search: async (query: string, minScore?: number) => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath || !query.trim()) return

    set({ isSearching: true, searchQuery: query })

    try {
      const { searchMode } = get()
      const response = await invoke<SearchResponse>('rag_search', {
        workspacePath,
        query,
        topK: 10,
        searchMode,
        minScore: minScore || null,
      })

      set({
        searchResults: response.results,
        searchTime: response.queryTimeMs,
        searchReranked: response.reranked,
        searchRerankError: response.rerankError || null,
      })
    } catch (error) {
      console.error('Search failed:', error)
      const message = error instanceof Error ? error.message : String(error)
      toast.error(i18n.t('knowledge.toast.searchFailed', { message }))
      set({ searchResults: [] })
    } finally {
      set({ isSearching: false })
    }
  },

  searchForAutoInject: async (query: string, topK: number, minScore: number): Promise<SearchResult[]> => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath || !query.trim()) return []

    try {
      const response = await invoke<SearchResponse>('rag_search', {
        workspacePath,
        query,
        topK,
        searchMode: 'hybrid',
        minScore,
      })

      return response.results
    } catch (error) {
      console.error('[RAG Auto-Inject] Search failed:', error)
      return []
    }
  },

  setSearchMode: (mode) => {
    set({ searchMode: mode })
    // Re-search if there's a query
    const { searchQuery, search } = get()
    if (searchQuery.trim()) {
      search(searchQuery)
    }
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query })
  },

  clearSearch: () => {
    set({ searchResults: [], searchQuery: '', searchTime: 0 })
  },

  // ============================================================================
  // Document Actions
  // ============================================================================

  loadDocuments: async () => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return

    try {
      await withAsync(set, async () => {
        const docs = await invoke<DocumentRecord[]>('rag_list_documents', {
          workspacePath,
        })
        set({ documents: docs })
      }, { loadingKey: 'isLoadingDocuments', rethrow: true })
    } catch (error) {
      console.error('Failed to load documents:', error)
      toast.error(i18n.t('knowledge.toast.loadDocumentsFailed'))
    }
  },

  deleteDocument: async (path: string) => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return

    try {
      await invoke('rag_delete_document', {
        workspacePath,
        path,
      })

      toast.success(i18n.t('knowledge.toast.documentDeleted'))

      // Reload documents and status
      await get().loadDocuments()
      await get().loadIndexStatus()
    } catch (error) {
      console.error('Failed to delete document:', error)
      toast.error(i18n.t('knowledge.toast.deleteDocumentFailed'))
    }
  },

  // ============================================================================
  // Config Actions
  // ============================================================================

  loadConfig: async () => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return

    try {
      await withAsync(set, async () => {
        const config = await invoke<RagConfig>('rag_get_config', {
          workspacePath,
        })
        set({ config })
      }, { loadingKey: 'isLoadingConfig', rethrow: true })
    } catch (error) {
      console.error('Failed to load config:', error)
      toast.error(i18n.t('knowledge.toast.loadConfigFailed'))
    }
  },

  saveConfig: async (config: RagConfig) => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return

    const oldConfig = get().config

    try {
      await invoke('rag_save_config', {
        workspacePath,
        config,
      })

      // Check if any index-affecting parameters changed
      // Auto-inject config changes don't require reindex
      const needsReindex = oldConfig && (
        oldConfig.embeddingProvider !== config.embeddingProvider ||
        oldConfig.embeddingModel !== config.embeddingModel ||
        oldConfig.embeddingDimensions !== config.embeddingDimensions ||
        oldConfig.embeddingBaseUrl !== config.embeddingBaseUrl ||
        oldConfig.chunkSize !== config.chunkSize ||
        oldConfig.chunkOverlap !== config.chunkOverlap
      )

      set({ config, needsReindex: needsReindex || false })
      
      if (needsReindex) {
        toast.warning(i18n.t('knowledge.toast.configSavedNeedsReindex'))
      } else {
        toast.success(i18n.t('knowledge.toast.configSaved'))
      }
    } catch (error) {
      console.error('Failed to save config:', error)
      toast.error(i18n.t('knowledge.toast.saveConfigFailed'))
    }
  },

  setNeedsReindex: (needs: boolean) => {
    set({ needsReindex: needs })
  },

  // ============================================================================
  // Watcher Actions
  // ============================================================================

  startWatcher: async () => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return

    try {
      await invoke('rag_start_watcher', {
        workspacePath,
      })
      console.log('[RAG] File watcher started')
    } catch (error) {
      console.error('Failed to start watcher:', error)
      toast.error(i18n.t('knowledge.toast.startWatcherFailed'))
    }
  },

  stopWatcher: async () => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return

    try {
      await invoke('rag_stop_watcher', {
        workspacePath,
      })
      toast.success(i18n.t('knowledge.toast.watcherStopped'))
    } catch (error) {
      console.error('Failed to stop watcher:', error)
      toast.error(i18n.t('knowledge.toast.stopWatcherFailed'))
    }
  },

  // ============================================================================
  // Auto-initialization
  // ============================================================================

  initForWorkspace: async () => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return

    // Load initial state
    await get().loadConfig()
    await get().loadIndexStatus()

    const config = get().config
    const indexStatus = get().indexStatus

    // Auto-index on startup if enabled
    // - For existing indexes: detects changes made while system was offline
    // - For new indexes: performs initial indexing of knowledge/ directory
    if (config?.autoIndex && indexStatus !== null) {
      const isFirstIndex = indexStatus.totalDocuments === 0
      console.log(
        isFirstIndex 
          ? 'Auto-indexing on startup (first-time index)...' 
          : 'Auto-indexing on startup to detect offline changes...'
      )
      // Run in background without blocking UI
      setTimeout(async () => {
        try {
          await get().startIndex(undefined, true) // silent mode
        } catch (error) {
          console.error('Failed to auto-index on startup:', error)
        }
      }, 1000) // Delay 1s to let UI load first
    }

    // Start file watcher if enabled
    if (config?.fileWatcherEnabled) {
      await get().startWatcher()
    }
  },

  cleanup: () => {
    set({
      indexStatus: null,
      isIndexing: false,
      indexProgress: null,
      needsReindex: false,
      searchResults: [],
      searchQuery: '',
      searchTime: 0,
      documents: [],
      config: null,
    })
  },
}))

// Subscribe to workspace changes
if (typeof window !== 'undefined') {
  let previousWorkspacePath = useWorkspaceStore.getState().workspacePath
  
  useWorkspaceStore.subscribe((state) => {
    const currentWorkspacePath = state.workspacePath
    
    if (currentWorkspacePath !== previousWorkspacePath) {
      if (currentWorkspacePath) {
        // Initialize knowledge store for new workspace
        useKnowledgeStore.getState().initForWorkspace()
      } else {
        // Cleanup when workspace is cleared
        useKnowledgeStore.getState().cleanup()
      }
      previousWorkspacePath = currentWorkspacePath
    }
  })
}
