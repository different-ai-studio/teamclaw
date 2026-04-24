import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/lib/storage', () => ({
  loadFromStorage: vi.fn(() => ({ nodes: [], version: 1 })),
  saveToStorage: vi.fn(),
}))

describe('team members shortcut role sync', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { useShortcutsStore } = await import('@/stores/shortcuts')
    const { useTeamMembersStore } = await import('@/stores/team-members')
    useShortcutsStore.setState({
      nodes: [],
      teamNodes: [],
      teamLoaded: false,
      currentShortcutRoles: [],
    })
    useTeamMembersStore.setState({
      members: [],
      myRole: null,
      loading: false,
      error: null,
      applications: [],
      _unlistenApplications: null,
      currentNodeId: null,
    })
  })

  it('sets current shortcut roles when members and current node id are loaded', async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_device_info') return { nodeId: 'node-1' }
      if (command === 'unified_team_get_members') {
        return [
          {
            nodeId: 'node-1',
            name: 'Alice',
            role: 'editor',
            shortcutsRole: ['sales', 'support'],
            label: '',
            platform: 'darwin',
            arch: 'arm64',
            hostname: 'alice-mac',
            addedAt: '2026-04-24T00:00:00Z',
          },
        ]
      }
      return null
    })

    const { useShortcutsStore } = await import('@/stores/shortcuts')
    const { useTeamMembersStore } = await import('@/stores/team-members')

    await useTeamMembersStore.getState().loadCurrentNodeId()
    await useTeamMembersStore.getState().loadMembers()

    expect(useShortcutsStore.getState().currentShortcutRoles).toEqual(['sales', 'support'])
  })

  it('clears current shortcut roles when the team members store resets', async () => {
    const { useShortcutsStore } = await import('@/stores/shortcuts')
    const { useTeamMembersStore } = await import('@/stores/team-members')

    useShortcutsStore.getState().setCurrentShortcutRoles(['sales'])
    useTeamMembersStore.getState().reset()

    expect(useShortcutsStore.getState().currentShortcutRoles).toEqual([])
  })

  it('clears current shortcut roles when loading team members fails', async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'unified_team_get_members') {
        throw new Error('members unavailable')
      }
      return null
    })

    const { useShortcutsStore } = await import('@/stores/shortcuts')
    const { useTeamMembersStore } = await import('@/stores/team-members')

    useShortcutsStore.getState().setCurrentShortcutRoles(['sales'])
    useTeamMembersStore.setState({ currentNodeId: 'node-1' })

    await useTeamMembersStore.getState().loadMembers()

    expect(useShortcutsStore.getState().currentShortcutRoles).toEqual([])
  })

  it('clears current shortcut roles when loading the current node id fails', async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_device_info') {
        throw new Error('device unavailable')
      }
      return null
    })

    const { useShortcutsStore } = await import('@/stores/shortcuts')
    const { useTeamMembersStore } = await import('@/stores/team-members')

    useShortcutsStore.getState().setCurrentShortcutRoles(['sales'])

    await useTeamMembersStore.getState().loadCurrentNodeId()

    expect(useShortcutsStore.getState().currentShortcutRoles).toEqual([])
  })
})
