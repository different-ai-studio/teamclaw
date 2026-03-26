import { create } from 'zustand'
import { loadFromStorage, saveToStorage } from '@/lib/storage'
import { appShortName } from '@/lib/build-config'

const STORAGE_KEY = `${appShortName}-custom-suggestions`

interface SuggestionsState {
  customSuggestions: string[]
  addSuggestion: (text: string) => void
  removeSuggestion: (index: number) => void
  reorderSuggestions: (suggestions: string[]) => void
}

export const useSuggestionsStore = create<SuggestionsState>((set, get) => ({
  customSuggestions: loadFromStorage<string[]>(STORAGE_KEY, []),

  addSuggestion: (text) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const updated = [...get().customSuggestions, trimmed]
    set({ customSuggestions: updated })
    saveToStorage(STORAGE_KEY, updated)
  },

  removeSuggestion: (index) => {
    const updated = get().customSuggestions.filter((_, i) => i !== index)
    set({ customSuggestions: updated })
    saveToStorage(STORAGE_KEY, updated)
  },

  reorderSuggestions: (suggestions) => {
    set({ customSuggestions: suggestions })
    saveToStorage(STORAGE_KEY, suggestions)
  },
}))
