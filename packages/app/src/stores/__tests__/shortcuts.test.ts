import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/storage', () => ({
  loadFromStorage: vi.fn(() => ({ nodes: [], version: 1 })),
  saveToStorage: vi.fn(),
}))

import { useShortcutsStore } from '@/stores/shortcuts'

describe('shortcuts store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useShortcutsStore.setState({ nodes: [], teamNodes: [], teamLoaded: false, currentShortcutRoles: [] })
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

  it('getTree keeps personal shortcuts while filtering team shortcuts by role', () => {
    useShortcutsStore.setState({
      nodes: [{ id: 'personal-1', label: 'P', order: 0, parentId: null, type: 'link', target: 'https://p.com' }],
      teamNodes: [
        { id: 'sales', label: 'Sales CRM', order: 0, parentId: null, type: 'link', target: 'https://sales.example.com', role: ['sales'] },
        { id: 'support', label: 'Support Queue', order: 1, parentId: null, type: 'link', target: 'https://support.example.com', role: ['support'] },
        { id: 'public', label: 'Handbook', order: 2, parentId: null, type: 'link', target: 'https://handbook.example.com' },
      ],
      teamLoaded: true,
    })
    useShortcutsStore.getState().setCurrentShortcutRoles(['sales'])

    const tree = useShortcutsStore.getState().getTree()

    expect(tree.map((node) => node.id)).toEqual(['personal-1', 'sales', 'public'])
  })

  it('setTeamNodes updates team shortcuts', () => {
    useShortcutsStore.getState().setTeamNodes([
      { id: 'team-1', label: 'Team', order: 0, parentId: null, type: 'link', target: 'https://team.com' }
    ])
    expect(useShortcutsStore.getState().teamNodes).toHaveLength(1)
    expect(useShortcutsStore.getState().teamLoaded).toBe(true)
  })

  it('keeps unrestricted team shortcuts visible when current shortcut roles are empty', () => {
    useShortcutsStore.setState({
      nodes: [],
      teamNodes: [
        { id: 'missing-role', label: 'Docs', order: 0, parentId: null, type: 'link', target: 'https://docs.example.com' },
        { id: 'empty-role', label: 'Wiki', order: 1, parentId: null, type: 'link', target: 'https://wiki.example.com', role: [] },
      ],
      teamLoaded: true,
    })
    useShortcutsStore.getState().setCurrentShortcutRoles([])

    const tree = useShortcutsStore.getState().getTeamTree()

    expect(tree.map((node) => node.id)).toEqual(['missing-role', 'empty-role'])
  })

  it('filters restricted team shortcuts by current member shortcut roles', () => {
    useShortcutsStore.setState({
      nodes: [],
      teamNodes: [
        { id: 'sales', label: 'Sales CRM', order: 0, parentId: null, type: 'link', target: 'https://sales.example.com', role: ['sales'] },
        { id: 'support', label: 'Support Queue', order: 1, parentId: null, type: 'link', target: 'https://support.example.com', role: ['support'] },
        { id: 'public', label: 'Handbook', order: 2, parentId: null, type: 'link', target: 'https://handbook.example.com' },
      ],
      teamLoaded: true,
    })
    useShortcutsStore.getState().setCurrentShortcutRoles(['sales'])

    const tree = useShortcutsStore.getState().getTeamTree()

    expect(tree.map((node) => node.id)).toEqual(['sales', 'public'])
  })

  it('hides restricted team shortcuts when no current member shortcut role matches', () => {
    useShortcutsStore.setState({
      nodes: [],
      teamNodes: [
        { id: 'sales', label: 'Sales CRM', order: 0, parentId: null, type: 'link', target: 'https://sales.example.com', role: ['sales'] },
        { id: 'support', label: 'Support Queue', order: 1, parentId: null, type: 'link', target: 'https://support.example.com', role: ['support'] },
      ],
      teamLoaded: true,
    })
    useShortcutsStore.getState().setCurrentShortcutRoles(['ops'])

    const tree = useShortcutsStore.getState().getTeamTree()

    expect(tree).toEqual([])
  })

  it('keeps a restricted folder when a visible child remains', () => {
    useShortcutsStore.setState({
      nodes: [],
      teamNodes: [
        { id: 'folder', label: 'Team Tools', order: 0, parentId: null, type: 'folder', target: '', role: ['admin'] },
        { id: 'sales-child', label: 'Sales CRM', order: 0, parentId: 'folder', type: 'link', target: 'https://sales.example.com', role: ['sales'] },
        { id: 'support-child', label: 'Support Queue', order: 1, parentId: 'folder', type: 'link', target: 'https://support.example.com', role: ['support'] },
      ],
      teamLoaded: true,
    })
    useShortcutsStore.getState().setCurrentShortcutRoles(['sales'])

    const tree = useShortcutsStore.getState().getTeamTree()

    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('folder')
    expect(tree[0].children?.map((node) => node.id)).toEqual(['sales-child'])
  })

  it('hides a restricted non-folder parent even when a visible child remains', () => {
    useShortcutsStore.setState({
      nodes: [],
      teamNodes: [
        { id: 'admin-link', label: 'Admin Console', order: 0, parentId: null, type: 'link', target: 'https://admin.example.com', role: ['admin'] },
        { id: 'sales-child', label: 'Sales CRM', order: 0, parentId: 'admin-link', type: 'link', target: 'https://sales.example.com', role: ['sales'] },
      ],
      teamLoaded: true,
    })
    useShortcutsStore.getState().setCurrentShortcutRoles(['sales'])

    const tree = useShortcutsStore.getState().getTeamTree()

    expect(tree).toEqual([])
  })
})
