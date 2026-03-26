import { create } from 'zustand'
import { loadFromStorage, saveToStorage } from '@/lib/storage'
import { appShortName } from '@/lib/build-config'

export interface ShortcutNode {
  id: string
  label: string
  icon?: string
  order: number
  parentId: string | null
  type: 'native' | 'link' | 'folder'
  target: string
  children?: ShortcutNode[]
}

interface ShortcutsState {
  nodes: ShortcutNode[]
  teamNodes: ShortcutNode[]
  teamLoaded: boolean

  addNode: (node: Omit<ShortcutNode, 'id'>) => string
  updateNode: (id: string, updates: Partial<ShortcutNode>) => void
  deleteNode: (id: string) => void
  moveNode: (id: string, parentId: string | null, order: number) => void
  batchMove: (moves: { id: string; parentId: string | null; order: number }[]) => void
  getTree: () => ShortcutNode[]
  getPersonalTree: () => ShortcutNode[]
  getTeamTree: () => ShortcutNode[]
  getChildren: (parentId: string | null) => ShortcutNode[]
  setTeamNodes: (nodes: ShortcutNode[]) => void
}

const STORAGE_KEY = `${appShortName}-shortcuts`

function loadPersistedNodes(): ShortcutNode[] {
  const stored = loadFromStorage<{ nodes: ShortcutNode[]; version: number }>(STORAGE_KEY, { nodes: [], version: 1 })
  return stored.nodes || []
}

function persistNodes(nodes: ShortcutNode[]): void {
  saveToStorage(STORAGE_KEY, { nodes, version: 1 })
}

function generateId(): string {
  return `shortcut-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function buildTree(nodes: ShortcutNode[], parentId: string | null): ShortcutNode[] {
  return nodes
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((node) => ({
      ...node,
      children: buildTree(nodes, node.id),
    }))
}

export const useShortcutsStore = create<ShortcutsState>((set, get) => ({
  nodes: loadPersistedNodes(),
  teamNodes: [],
  teamLoaded: false,

  addNode: (node) => {
    const id = generateId()
    const newNode: ShortcutNode = { ...node, id }
    set((state) => {
      const newNodes = [...state.nodes, newNode]
      persistNodes(newNodes)
      return { nodes: newNodes }
    })
    return id
  },

  updateNode: (id, updates) => {
    set((state) => {
      const newNodes = state.nodes.map((node) =>
        node.id === id ? { ...node, ...updates } : node
      )
      persistNodes(newNodes)
      return { nodes: newNodes }
    })
  },

  deleteNode: (id) => {
    set((state) => {
      const idsToDelete = new Set<string>()
      const collectChildren = (parentId: string) => {
        state.nodes.forEach((node) => {
          if (node.parentId === parentId) {
            idsToDelete.add(node.id)
            collectChildren(node.id)
          }
        })
      }
      idsToDelete.add(id)
      collectChildren(id)

      const newNodes = state.nodes.filter((n) => !idsToDelete.has(n.id))
      persistNodes(newNodes)

      return { nodes: newNodes }
    })
  },

  moveNode: (id, parentId, order) => {
    set((state) => {
      const newNodes = state.nodes.map((node) =>
        node.id === id ? { ...node, parentId, order } : node
      )
      persistNodes(newNodes)
      return { nodes: newNodes }
    })
  },

  batchMove: (moves) => {
    set((state) => {
      const moveMap = new Map(moves.map((m) => [m.id, m]))
      const newNodes = state.nodes.map((node) => {
        const m = moveMap.get(node.id)
        return m ? { ...node, parentId: m.parentId, order: m.order } : node
      })
      persistNodes(newNodes)
      return { nodes: newNodes }
    })
  },

  getTree: () => {
    const { nodes, teamNodes } = get()
    const personalTree = buildTree(nodes, null)
    const teamTree = buildTree(teamNodes, null)
    return [...personalTree, ...teamTree]
  },

  getPersonalTree: () => {
    const { nodes } = get()
    return buildTree(nodes, null)
  },

  getTeamTree: () => {
    const { teamNodes } = get()
    return buildTree(teamNodes, null)
  },

  getChildren: (parentId) => {
    const { nodes } = get()
    return nodes
      .filter((n) => n.parentId === parentId)
      .sort((a, b) => a.order - b.order)
  },

  setTeamNodes: (nodes) => {
    set({ teamNodes: nodes, teamLoaded: true })
  },
}))