import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { useWorkspaceStore } from './workspace'
import { withAsync } from '@/lib/store-utils'

// ============================================================================
// Types
// ============================================================================

export interface MemoryRecord {
  filename: string
  title: string
  category: string
  tags: string[]
  created: string
  updated: string
  content: string
}

interface MemoryState {
  memories: MemoryRecord[]
  isLoading: boolean
  error: string | null
  searchQuery: string
  selectedCategory: string | null
  isExtracting: boolean

  loadMemories: () => Promise<void>
  searchMemories: (query: string) => Promise<void>
  deleteMemory: (filename: string) => Promise<void>
  triggerExtraction: () => Promise<void>

  setSearchQuery: (query: string) => void
  setSelectedCategory: (category: string | null) => void
  resetState: () => void
}

// ============================================================================
// Store
// ============================================================================

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  isLoading: false,
  error: null,
  searchQuery: '',
  selectedCategory: null,
  isExtracting: false,

  loadMemories: async () => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return

    await withAsync(set, async () => {
      const memories = await invoke<MemoryRecord[]>('rag_list_memories', {
        workspacePath,
      })
      set({ memories })
    })
  },

  searchMemories: async (query: string) => {
    set({ searchQuery: query })
    if (!query.trim()) {
      await get().loadMemories()
      return
    }

    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return

    await withAsync(set, async () => {
      const response = await invoke<{
        results: Array<{
          content: string
          source: string
          score: number
        }>
      }>('rag_search', {
        workspacePath,
        query,
        topK: 20,
        searchMode: 'hybrid',
        minScore: 0.3,
      })

      const memoryResults = response.results.filter(
        r => r.source.startsWith('memory/') || r.source.startsWith('knowledge/memory/'),
      )

      const filenameSet = new Set(memoryResults.map(r => {
        const parts = r.source.split('/')
        return parts[parts.length - 1]
      }))

      const allMemories = await invoke<MemoryRecord[]>('rag_list_memories', {
        workspacePath,
      })

      const matched = allMemories.filter(m => filenameSet.has(m.filename))
      set({ memories: matched })
    })
  },

  deleteMemory: async (filename: string) => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return

    try {
      await invoke('rag_delete_memory', { workspacePath, filename })
      toast.success('记忆已删除')
      await get().loadMemories()
    } catch (error) {
      console.error('Failed to delete memory:', error)
      toast.error('删除记忆失败')
    }
  },

  triggerExtraction: async () => {
    set({ isExtracting: true })
    try {
      const { useSessionStore } = await import('./session')
      const { triggerManualExtraction } = await import('@/lib/memory-extraction')
      const workspacePath = useWorkspaceStore.getState().workspacePath
      if (!workspacePath) {
        toast.error('请先打开一个工作区')
        return
      }

      const { activeSessionId, sessions } = useSessionStore.getState()
      if (!activeSessionId) {
        toast.error('请先打开一个会话')
        return
      }

      const session = sessions.find(s => s.id === activeSessionId)
      if (!session || session.messages.length < 2) {
        toast.error('当前会话消息不足')
        return
      }

      const conversationMessages = session.messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .filter(m => m.content && m.content.trim())
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

      await triggerManualExtraction(conversationMessages, activeSessionId, workspacePath)
      toast.success('记忆提取任务已提交')
    } catch (error) {
      console.error('Manual extraction failed:', error)
      toast.error('记忆提取失败')
    } finally {
      set({ isExtracting: false })
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedCategory: (category) => set({ selectedCategory: category }),
  resetState: () =>
    set({
      memories: [],
      isLoading: false,
      error: null,
      searchQuery: '',
      selectedCategory: null,
      isExtracting: false,
    }),
}))
