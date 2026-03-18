import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: Object.assign(
    (sel: (s: any) => any) => sel({ workspacePath: '/test/workspace' }),
    { getState: () => ({ workspacePath: '/test/workspace' }) },
  ),
}))

vi.mock('@/lib/store-utils', () => ({
  withAsync: async (set: any, fn: any, opts?: any) => {
    set({ isLoading: true, error: null })
    try {
      const result = await fn()
      set({ isLoading: false })
      return result
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), isLoading: false })
      if (opts?.rethrow) throw error
    }
  },
}))

import { useMemoryStore } from '@/stores/memory'

describe('memory store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useMemoryStore.setState({
      memories: [],
      isLoading: false,
      error: null,
      searchQuery: '',
      selectedCategory: null,
      isExtracting: false,
    })
  })

  it('has correct initial state', () => {
    const state = useMemoryStore.getState()
    expect(state.memories).toEqual([])
    expect(state.isLoading).toBe(false)
    expect(state.searchQuery).toBe('')
    expect(state.selectedCategory).toBeNull()
  })

  it('loadMemories fetches from backend', async () => {
    const mockMemories = [
      { filename: 'test.md', title: 'Test', category: 'general', tags: [], created: '', updated: '', content: 'hello' },
    ]
    mockInvoke.mockResolvedValue(mockMemories)

    await useMemoryStore.getState().loadMemories()

    expect(mockInvoke).toHaveBeenCalledWith('rag_list_memories', { workspacePath: '/test/workspace' })
    expect(useMemoryStore.getState().memories).toEqual(mockMemories)
  })

  it('setSearchQuery updates search query', () => {
    useMemoryStore.getState().setSearchQuery('test query')
    expect(useMemoryStore.getState().searchQuery).toBe('test query')
  })

  it('setSelectedCategory updates selected category', () => {
    useMemoryStore.getState().setSelectedCategory('work')
    expect(useMemoryStore.getState().selectedCategory).toBe('work')
  })

  it('resetState clears all state', () => {
    useMemoryStore.setState({
      memories: [{ filename: 'a', title: 'A', category: 'x', tags: [], created: '', updated: '', content: '' }],
      searchQuery: 'query',
      selectedCategory: 'cat',
      isExtracting: true,
    })
    useMemoryStore.getState().resetState()
    const state = useMemoryStore.getState()
    expect(state.memories).toEqual([])
    expect(state.searchQuery).toBe('')
    expect(state.selectedCategory).toBeNull()
    expect(state.isExtracting).toBe(false)
  })
})
