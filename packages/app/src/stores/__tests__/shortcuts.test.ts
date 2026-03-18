import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/storage', () => ({
  loadFromStorage: vi.fn(() => ({ nodes: [], version: 1 })),
  saveToStorage: vi.fn(),
}))

import { useShortcutsStore } from '@/stores/shortcuts'

describe('shortcuts store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useShortcutsStore.setState({ nodes: [], teamNodes: [], teamLoaded: false })
  })

  it('starts with empty nodes', () => {
    expect(useShortcutsStore.getState().nodes).toEqual([])
  })

  it('addNode adds a node and returns an id', () => {
    const id = useShortcutsStore.getState().addNode({
      label: 'Test Shortcut',
      order: 0,
      parentId: null,
      type: 'link',
      target: 'https://example.com',
    })
    expect(typeof id).toBe('string')
    expect(id.startsWith('shortcut-')).toBe(true)
    const nodes = useShortcutsStore.getState().nodes
    expect(nodes).toHaveLength(1)
    expect(nodes[0].label).toBe('Test Shortcut')
  })

  it('updateNode modifies existing node', () => {
    const id = useShortcutsStore.getState().addNode({
      label: 'Original',
      order: 0,
      parentId: null,
      type: 'link',
      target: 'https://example.com',
    })
    useShortcutsStore.getState().updateNode(id, { label: 'Updated' })
    expect(useShortcutsStore.getState().nodes[0].label).toBe('Updated')
  })

  it('deleteNode removes node and its children', () => {
    const parentId = useShortcutsStore.getState().addNode({
      label: 'Parent',
      order: 0,
      parentId: null,
      type: 'folder',
      target: '',
    })
    useShortcutsStore.getState().addNode({
      label: 'Child',
      order: 0,
      parentId,
      type: 'link',
      target: 'https://child.com',
    })
    expect(useShortcutsStore.getState().nodes).toHaveLength(2)
    useShortcutsStore.getState().deleteNode(parentId)
    expect(useShortcutsStore.getState().nodes).toHaveLength(0)
  })

  it('getTree builds nested structure', () => {
    const parentId = useShortcutsStore.getState().addNode({
      label: 'Folder',
      order: 0,
      parentId: null,
      type: 'folder',
      target: '',
    })
    useShortcutsStore.getState().addNode({
      label: 'Link',
      order: 0,
      parentId,
      type: 'link',
      target: 'https://test.com',
    })
    const tree = useShortcutsStore.getState().getTree()
    expect(tree).toHaveLength(1)
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children![0].label).toBe('Link')
  })

  it('getPersonalTree returns only personal shortcuts', () => {
    useShortcutsStore.setState({
      nodes: [{ id: 'personal-1', label: 'P', order: 0, parentId: null, type: 'link', target: 'https://p.com' }],
      teamNodes: [{ id: 'team-1', label: 'T', order: 0, parentId: null, type: 'link', target: 'https://t.com' }],
    })
    const tree = useShortcutsStore.getState().getPersonalTree()
    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('personal-1')
  })

  it('getTeamTree returns only team shortcuts', () => {
    useShortcutsStore.setState({
      nodes: [{ id: 'personal-1', label: 'P', order: 0, parentId: null, type: 'link', target: 'https://p.com' }],
      teamNodes: [{ id: 'team-1', label: 'T', order: 0, parentId: null, type: 'link', target: 'https://t.com' }],
    })
    const tree = useShortcutsStore.getState().getTeamTree()
    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('team-1')
  })

  it('getTree returns merged tree with personal first', () => {
    useShortcutsStore.setState({
      nodes: [{ id: 'personal-1', label: 'P', order: 0, parentId: null, type: 'link', target: 'https://p.com' }],
      teamNodes: [{ id: 'team-1', label: 'T', order: 0, parentId: null, type: 'link', target: 'https://t.com' }],
    })
    const tree = useShortcutsStore.getState().getTree()
    expect(tree).toHaveLength(2)
    expect(tree[0].id).toBe('personal-1')
    expect(tree[1].id).toBe('team-1')
  })

  it('setTeamNodes updates team shortcuts', () => {
    useShortcutsStore.getState().setTeamNodes([
      { id: 'team-1', label: 'Team', order: 0, parentId: null, type: 'link', target: 'https://team.com' }
    ])
    expect(useShortcutsStore.getState().teamNodes).toHaveLength(1)
    expect(useShortcutsStore.getState().teamLoaded).toBe(true)
  })
})
