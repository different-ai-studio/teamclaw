import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SidebarSecondColumn } from '../SidebarSecondColumn'
import { useUIStore } from '@/stores/ui'
import { useShortcutsStore } from '@/stores/shortcuts'

vi.mock('../SessionListColumn', () => ({
  SessionListColumn: () => <div data-testid="session-list-column" />,
}))

vi.mock('@/stores/tabs', () => ({
  selectActiveTab: () => null,
  useTabsStore: Object.assign(
    vi.fn((selector?: any) => {
      const state = {
        tabs: [],
        openTab: vi.fn(),
      }
      return selector ? selector(state) : state
    }),
    {
      getState: () => ({ openTab: vi.fn(), tabs: [] }),
    },
  ),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((selector?: any) => {
    const state = { workspacePath: '/workspace' }
    return selector ? selector(state) : state
  }),
}))

vi.mock('@/lib/team-shortcuts', () => ({
  loadTeamShortcutsFile: vi.fn(async () => []),
}))

describe('SidebarSecondColumn', () => {
  beforeEach(() => {
    useShortcutsStore.setState({
      nodes: [
        {
          id: 'shortcut-1',
          label: 'Docs',
          order: 0,
          parentId: null,
          type: 'link',
          target: 'https://docs.example.com',
        },
      ],
      teamNodes: [],
      currentShortcutRoles: [],
    })
  })

  it('renders SessionListColumn for normal session filters', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'all' } })
    render(<SidebarSecondColumn />)
    expect(screen.getByTestId('session-list-column')).toBeInTheDocument()
  })

  it('renders shortcuts when the shortcuts filter is active', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'shortcuts' } })
    render(<SidebarSecondColumn />)
    expect(screen.getByText('Shortcuts')).toBeInTheDocument()
    expect(screen.getByText('Docs')).toBeInTheDocument()
    expect(screen.queryByTestId('session-list-column')).not.toBeInTheDocument()
  })
})
