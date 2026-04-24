import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
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
  role?: string[]
  children?: ShortcutNode[]
}

interface ShortcutsState {
  nodes: ShortcutNode[]
  teamNodes: ShortcutNode[]
  teamLoaded: boolean
  currentShortcutRoles: string[]

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
  setCurrentShortcutRoles: (roles: string[] | null | undefined) => void
}

const STORAGE_KEY = `${appShortName}-shortcuts`

function loadPersistedNodes(): ShortcutNode[] {
  const stored = loadFromStorage<{ nodes: ShortcutNode[]; version: number }>(STORAGE_KEY, { nodes: [], version: 1 })
  return stored.nodes || []
}

async function loadPersistedNodesAsync(): Promise<ShortcutNode[]> {
  try {
    const nodes = await invoke<ShortcutNode[]>('load_shortcuts')
    if (nodes && nodes.length > 0) {
      return nodes
    }
  } catch {
    // File not available or no workspace set — fall back to localStorage
  }
  return loadPersistedNodes()
}

function persistNodes(nodes: ShortcutNode[]): void {
  // Write to localStorage for backwards compatibility
  saveToStorage(STORAGE_KEY, { nodes, version: 1 })
  // Also persist to file so the MCP server can read/write shortcuts
  invoke('save_shortcuts', { nodes }).catch(() => {
    // Ignore errors — file write is best-effort (no workspace may be set yet)
  })
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

function normalizeRoles(roles: string[] | null | undefined): string[] {
  if (!Array.isArray(roles)) return []
  return roles.filter((role): role is string => typeof role === 'string' && role.trim().length > 0)
}

function canSeeTeamShortcut(node: ShortcutNode, currentRoles: string[]): boolean {
  const shortcutRoles = normalizeRoles(node.role)
  if (shortcutRoles.length === 0) return true
  if (currentRoles.length === 0) return false
  const currentRoleSet = new Set(currentRoles)
  return shortcutRoles.some((role) => currentRoleSet.has(role))
}

function filterTeamTreeForRoles(tree: ShortcutNode[], currentRoles: string[]): ShortcutNode[] {
  return tree.flatMap((node) => {
    const filteredChildren = filterTeamTreeForRoles(node.children ?? [], currentRoles)
    if (!canSeeTeamShortcut(node, currentRoles) && (node.type !== 'folder' || filteredChildren.length === 0)) {
      return []
    }
    return [{ ...node, children: filteredChildren }]
  })
}

export const useShortcutsStore = create<ShortcutsState>((set, get) => {
  // Kick off async load from file; update store when result arrives
  loadPersistedNodesAsync().then((nodes) => {
    // Only update if the store still has the initial localStorage snapshot
    // (i.e. no mutations have happened yet that would override the file data)
    const current = get().nodes
    const initial = loadPersistedNodes()
    if (JSON.stringify(current) === JSON.stringify(initial)) {
      set({ nodes })
    }
  }).catch(() => {/* ignore */})

  return {
  nodes: loadPersistedNodes(),
  teamNodes: [],
  teamLoaded: false,
  currentShortcutRoles: [],

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
    const { nodes, teamNodes, currentShortcutRoles } = get()
    const personalTree = buildTree(nodes, null)
    const teamTree = filterTeamTreeForRoles(buildTree(teamNodes, null), currentShortcutRoles)
    return [...personalTree, ...teamTree]
  },

  getPersonalTree: () => {
    const { nodes } = get()
    return buildTree(nodes, null)
  },

  getTeamTree: () => {
    const { teamNodes, currentShortcutRoles } = get()
    return filterTeamTreeForRoles(buildTree(teamNodes, null), currentShortcutRoles)
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

  setCurrentShortcutRoles: (roles) => {
    set({ currentShortcutRoles: normalizeRoles(roles) })
  },
  }
})
